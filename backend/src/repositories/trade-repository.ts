/**
 * Repositorio de trades y trazabilidad de lotes (trade, trade_lot_consumption)
 * — [M3 orders].
 */
import { asc, eq, or } from "drizzle-orm";
import type { Tx } from "../db";
import { trade, tradeLotConsumption, type TradeRow } from "../db/schema";
import type { LotConsumption } from "../types/contracts";

export interface InsertTradeParams {
  buyOrderId: string;
  sellOrderId: string;
  buyerAgentId: string;
  sellerAgentId: string;
  productId: string;
  qtyExecutedCent: number;
  priceCents: number;
  /** Fee REALMENTE cobrado a cada lado (ya capado por available, §5). */
  feeBuyerCents: number;
  feeSellerCents: number;
}

export const tradeRepository = {
  async insertTrade(tx: Tx, p: InsertTradeParams): Promise<TradeRow> {
    const rows = await tx
      .insert(trade)
      .values({
        buyOrderId: p.buyOrderId,
        sellOrderId: p.sellOrderId,
        buyerAgentId: p.buyerAgentId,
        sellerAgentId: p.sellerAgentId,
        productId: p.productId,
        qtyExecuted: p.qtyExecutedCent,
        priceCents: p.priceCents,
        feeBuyerCents: p.feeBuyerCents,
        feeSellerCents: p.feeSellerCents,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("trade: INSERT no devolvió fila");
    }
    return row;
  },

  /**
   * Trazabilidad lote→trade del consumo FIFO del vendedor (COGS por trade).
   * `consumptions` es el detalle devuelto por inventoryService.consumeReservedFifo.
   */
  async insertLotConsumptions(
    tx: Tx,
    tradeId: string,
    consumptions: LotConsumption[],
  ): Promise<void> {
    if (consumptions.length === 0) return;
    await tx.insert(tradeLotConsumption).values(
      consumptions.map((c) => ({
        tradeId,
        lotId: c.lotId,
        qtyConsumed: c.qtyCent,
        unitCostCents: c.unitCostCents,
      })),
    );
  },

  /** Trades en los que participó una orden (como compra o venta), cronológicos. */
  async listByOrder(tx: Tx, orderId: string): Promise<TradeRow[]> {
    return tx
      .select()
      .from(trade)
      .where(or(eq(trade.buyOrderId, orderId), eq(trade.sellOrderId, orderId)))
      .orderBy(asc(trade.executedAt), asc(trade.tradeId));
  },
};
