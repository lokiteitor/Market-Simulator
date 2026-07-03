/**
 * Repositorio de visibilidad de mercado (market_order, trade) — [M6 read-side].
 *
 * Lecturas puras, nivel 1 (diseño §13). Los queries de top-of-book filtran
 * `status IN ('active','partial') AND expires_at > now` y ordenan por
 * precio-tiempo, apoyándose en los índices parciales idx_orderbook_buy /
 * idx_orderbook_sell del schema (producto, precio DESC|ASC, created_at ASC).
 */
import { and, asc, desc, eq, gt, gte, inArray } from "drizzle-orm";
import type { Tx } from "../db";
import { marketOrder, trade, type MarketOrderRow, type TradeRow } from "../db/schema";

export const marketRepository = {
  /**
   * Primera orden en cola precio-tiempo del lado dado, vigente al instante
   * `now`: buy ⇒ mejor precio DESC; sell ⇒ mejor precio ASC; empate por
   * created_at ASC. `undefined` si el lado está vacío.
   */
  async bestOrder(
    tx: Tx,
    productId: string,
    side: "buy" | "sell",
    now: Date,
  ): Promise<MarketOrderRow | undefined> {
    const rows = await tx
      .select()
      .from(marketOrder)
      .where(
        and(
          eq(marketOrder.productId, productId),
          eq(marketOrder.side, side),
          inArray(marketOrder.status, ["active", "partial"]),
          gt(marketOrder.expiresAt, now),
        ),
      )
      .orderBy(
        side === "buy"
          ? desc(marketOrder.limitPriceCents)
          : asc(marketOrder.limitPriceCents),
        asc(marketOrder.createdAt),
      )
      .limit(1);
    return rows[0];
  },

  /**
   * Trades públicos recientes del producto con `executed_at >= since`,
   * más recientes primero (usa idx_trade_product_time).
   */
  async recentTradesForProduct(
    tx: Tx,
    productId: string,
    since: Date,
    limit: number,
  ): Promise<TradeRow[]> {
    return tx
      .select()
      .from(trade)
      .where(and(eq(trade.productId, productId), gte(trade.executedAt, since)))
      .orderBy(desc(trade.executedAt), desc(trade.tradeId))
      .limit(limit);
  },
};
