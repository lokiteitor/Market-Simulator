/**
 * Controller de mercado: filas/objetos del service → DTOs snake_case del
 * openapi (TopOfBook, Trade) — [M6 read-side].
 */
import type { TradeRow } from "../db/schema";
import { cachedJson } from "../lib/read-cache";
import type { TopOfBookDto, TopOfBookSideDto, TradeDto } from "../schemas/market";
import { marketService, type TopOfBookSide } from "../services/market-service";

// TTLs del read-cache: staleness acotada muy por debajo del cacheo que los
// clientes ya aplican (los bots cachean el top 12 s) y, para órdenes limit,
// cotizar contra un top ligeramente viejo solo puede ejecutar a mejor precio.
// El techo de misses contra Postgres es ~155 productos / TTL: con 500 ms eran
// hasta ~310 queries/s (estampida observada en vivo); con 2,5 s son ~62/s.
const TOP_OF_BOOK_TTL_MS = 2_500;
const RECENT_TRADES_TTL_MS = 2_500;

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
    return cachedJson("top", `cache:top:${productId}`, TOP_OF_BOOK_TTL_MS, async () => {
      const top = await marketService.getTopOfBook(productId);
      return {
        product_id: top.productId,
        observed_at: top.observedAt.toISOString(),
        best_bid: toSideDto(top.bestBid),
        best_ask: toSideDto(top.bestAsk),
      };
    });
  },

  async getRecentTrades(
    productId: string,
    q: { since?: Date; until?: Date; before?: string; limit: number },
  ): Promise<TradeDto[]> {
    const compute = async (): Promise<TradeDto[]> => {
      const rows = await marketService.getRecentTrades(productId, q);
      return rows.map(toTradeDto);
    };
    // Solo se cachea la forma caliente (sin filtros temporales ni cursor: la
    // ventana por defecto que piden los bots); el backfill parametrizado va
    // directo a Postgres, su combinatoria de claves no amortiza.
    const noFilters =
      q.since === undefined && q.until === undefined && q.before === undefined;
    if (!noFilters) return compute();
    return cachedJson(
      "trades",
      `cache:trades:${productId}:${q.limit}`,
      RECENT_TRADES_TTL_MS,
      compute,
    );
  },
};
