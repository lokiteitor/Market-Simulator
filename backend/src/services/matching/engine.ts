/**
 * Matching engine (§10.1 EXACTO) — [M3 orders].
 *
 * Se ejecuta DENTRO de la transacción y del lock de producto abiertos por
 * placeOrder. Algoritmo, por iteración, hasta no-match o fill total del taker:
 *
 *   1. Mejor contraparte compatible con FOR UPDATE (precio-tiempo, sin
 *      self-trade, expires_at > now()) — `orderRepository.findBestCounterForUpdate`.
 *   2. qty = min(pendientes); precio efectivo = el de la orden PASIVA.
 *   3. Transferencias del §5:
 *        comprador: liberación telescópica de reserva (releaseForFill), paga
 *                   cost del monto liberado, sobrante a available, fee capado;
 *        vendedor : cobra cost en available, fee capado;
 *        inventario: consumo FIFO RESERVADO del vendedor → trade_lot_consumption;
 *                    lote purchase del comprador con
 *                    unit_cost = unitCostFromTotal(cost + fee_buyer, qty).
 *   4. INSERT trade; UPDATE ambas órdenes (qty_pending, status, updated_at);
 *      appendEvent(trade_executed) por trade.
 *
 * Devuelve el estado final del taker y la lista de trades ejecutados con los
 * datos que el service necesita para notificar post-commit (order_executed a
 * ambas contrapartes, con fill parcial/total de la orden de cada uno).
 */
import type { Tx } from "../../db";
import type { MarketOrderRow, TradeRow } from "../../db/schema";
import { appendEvent, type TradeExecutedPayload } from "../../lib/event-log";
import { orderRepository, type OrderStatus } from "../../repositories/order-repository";
import { tradeRepository } from "../../repositories/trade-repository";
import { inventoryService } from "../inventory-service";
import { applyBuyerFillCapital, chargeFeeCapped, creditAvailable } from "./capital";
import { buyerLotUnitCostCents, planFill, type Fill } from "./fill-math";

/** Un trade ejecutado + el resultado (parcial/total) para la orden de cada lado. */
export interface ExecutedTrade {
  trade: TradeRow;
  buyerFill: Fill;
  sellerFill: Fill;
}

export interface MatchOutcome {
  /** El taker tras el matching (qty_pending/status/updated_at frescos). */
  order: MarketOrderRow;
  trades: ExecutedTrade[];
}

export async function matchOrder(tx: Tx, insertedOrder: MarketOrderRow): Promise<MatchOutcome> {
  let taker: MarketOrderRow = insertedOrder;
  const executed: ExecutedTrade[] = [];

  while (taker.qtyPending > 0) {
    const passive = await orderRepository.findBestCounterForUpdate(tx, {
      productId: taker.productId,
      takerSide: taker.side,
      takerLimitPriceCents: taker.limitPriceCents,
      takerAgentId: taker.agentId,
    });
    if (passive === undefined) break;

    const plan = planFill({
      takerSide: taker.side,
      takerQtyPendingCent: taker.qtyPending,
      takerLimitPriceCents: taker.limitPriceCents,
      passiveQtyPendingCent: passive.qtyPending,
      passiveLimitPriceCents: passive.limitPriceCents,
    });

    const buyOrder = taker.side === "buy" ? taker : passive;
    const sellOrder = taker.side === "buy" ? passive : taker;

    // --- Capital (§5) ------------------------------------------------------
    // Comprador: reserva telescópica; el costo sale del monto liberado y el
    // sobrante vuelve a available. Después, su fee capado por available.
    await applyBuyerFillCapital(
      tx,
      buyOrder.agentId,
      plan.buyerReserveReleaseCents,
      plan.costCents,
    );
    const feeBuyerCents = await chargeFeeCapped(tx, buyOrder.agentId, plan.idealFeeCents);
    // Vendedor: cobra el costo en available y luego paga su fee capado.
    await creditAvailable(tx, sellOrder.agentId, plan.costCents);
    const feeSellerCents = await chargeFeeCapped(tx, sellOrder.agentId, plan.idealFeeCents);

    // --- Inventario del vendedor: consumo FIFO del pool RESERVADO ----------
    const consumptions = await inventoryService.consumeReservedFifo(
      tx,
      sellOrder.agentId,
      taker.productId,
      plan.execQtyCent,
    );

    // --- Trade + trazabilidad + lote purchase del comprador ----------------
    const trade = await tradeRepository.insertTrade(tx, {
      buyOrderId: buyOrder.orderId,
      sellOrderId: sellOrder.orderId,
      buyerAgentId: buyOrder.agentId,
      sellerAgentId: sellOrder.agentId,
      productId: taker.productId,
      qtyExecutedCent: plan.execQtyCent,
      priceCents: plan.priceCents,
      feeBuyerCents,
      feeSellerCents,
    });
    await tradeRepository.insertLotConsumptions(tx, trade.tradeId, consumptions);
    await inventoryService.createLot(tx, {
      agentId: buyOrder.agentId,
      productId: taker.productId,
      origin: "purchase",
      qtyCent: plan.execQtyCent,
      unitCostCents: buyerLotUnitCostCents(plan.costCents, feeBuyerCents, plan.execQtyCent),
      sourceTradeId: trade.tradeId,
    });

    // --- Actualizar ambas órdenes ------------------------------------------
    const takerStatus: OrderStatus = plan.takerQtyPendingAfterCent === 0 ? "completed" : "partial";
    const passiveStatus: OrderStatus =
      plan.passiveQtyPendingAfterCent === 0 ? "completed" : "partial";
    await orderRepository.applyFill(tx, taker.orderId, plan.takerQtyPendingAfterCent, takerStatus);
    await orderRepository.applyFill(
      tx,
      passive.orderId,
      plan.passiveQtyPendingAfterCent,
      passiveStatus,
    );

    // --- Evento (dentro de la misma tx, §0) --------------------------------
    const payload: TradeExecutedPayload = {
      trade_id: trade.tradeId,
      buy_order_id: trade.buyOrderId,
      sell_order_id: trade.sellOrderId,
      buyer_agent_id: trade.buyerAgentId,
      seller_agent_id: trade.sellerAgentId,
      product_id: trade.productId,
      qty_cent: trade.qtyExecuted,
      price_cents: trade.priceCents,
      fee_buyer_cents: trade.feeBuyerCents,
      fee_seller_cents: trade.feeSellerCents,
    };
    await appendEvent(tx, { type: "trade_executed", agentId: taker.agentId, payload });

    executed.push({
      trade,
      buyerFill: taker.side === "buy" ? plan.takerFill : plan.passiveFill,
      sellerFill: taker.side === "sell" ? plan.takerFill : plan.passiveFill,
    });

    taker = { ...taker, qtyPending: plan.takerQtyPendingAfterCent, status: takerStatus };
  }

  if (executed.length > 0) {
    // Releer el taker para devolver updated_at/status reales de la DB.
    const fresh = await orderRepository.getById(tx, taker.orderId);
    if (fresh !== undefined) taker = fresh;
  }

  return { order: taker, trades: executed };
}
