/**
 * Controller de mercado: filas/objetos del service → DTOs snake_case del
 * openapi (TopOfBook, Trade) — [M6 read-side].
 */
import type { TradeRow } from "../db/schema";
import type { TopOfBookDto, TopOfBookSideDto, TradeDto } from "../schemas/market";
import { marketService, type TopOfBookSide } from "../services/market-service";

/** Mapper compartido con el historial (history-controller lo reutiliza). */
export function toTradeDto(row: TradeRow): TradeDto {
  return {
    trade_id: row.tradeId,
    buy_order_id: row.buyOrderId,
    sell_order_id: row.sellOrderId,
    buyer_agent_id: row.buyerAgentId,
    seller_agent_id: row.sellerAgentId,
    product_id: row.productId,
    qty_executed_cent: row.qtyExecuted,
    price_cents: row.priceCents,
    fee_buyer_cents: row.feeBuyerCents,
    fee_seller_cents: row.feeSellerCents,
    executed_at: row.executedAt.toISOString(),
  };
}

function toSideDto(side: TopOfBookSide | null): TopOfBookSideDto | null {
  if (side === null) return null;
  return {
    order_id: side.orderId,
    agent_id: side.agentId,
    price_cents: side.priceCents,
    qty_pending_cent: side.qtyPendingCent,
  };
}

export const marketController = {
  async getTopOfBook(productId: string): Promise<TopOfBookDto> {
    const top = await marketService.getTopOfBook(productId);
    return {
      product_id: top.productId,
      observed_at: top.observedAt.toISOString(),
      best_bid: toSideDto(top.bestBid),
      best_ask: toSideDto(top.bestAsk),
    };
  },

  async getRecentTrades(
    productId: string,
    q: { since?: Date; until?: Date; before?: string; limit: number },
  ): Promise<TradeDto[]> {
    const rows = await marketService.getRecentTrades(productId, q);
    return rows.map(toTradeDto);
  },
};
