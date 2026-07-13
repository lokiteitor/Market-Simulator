/**
 * Repositorio de visibilidad de mercado (market_order, trade) — [M6 read-side].
 *
 * Lecturas puras, nivel 1 (diseño §13). Los queries de top-of-book filtran
 * `status IN ('active','partial') AND expires_at > now` y ordenan por
 * precio-tiempo, apoyándose en los índices parciales idx_orderbook_buy /
 * idx_orderbook_sell del schema (producto, precio DESC|ASC, created_at ASC).
 */
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, type SQL } from "drizzle-orm";
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

  /** Trade por id (para resolver el cursor `before`). */
  async tradeById(tx: Tx, tradeId: string): Promise<TradeRow | undefined> {
    const rows = await tx.select().from(trade).where(eq(trade.tradeId, tradeId)).limit(1);
    return rows[0];
  },

  /**
   * Trades públicos recientes del producto, más recientes primero (usa
   * idx_trade_product_time). Filtros opcionales: `since`/`until` acotan por
   * `executed_at`; `before` es keyset exacto sobre (executed_at, trade_id) —
   * estrictamente anteriores al trade cursor — para backfill sin huecos ni
   * duplicados aun con timestamps empatados.
   */
  async recentTradesForProduct(
    tx: Tx,
    productId: string,
    q: {
      since?: Date;
      until?: Date;
      before?: { executedAt: Date; tradeId: string };
      limit: number;
    },
  ): Promise<TradeRow[]> {
    const conditions: SQL[] = [eq(trade.productId, productId)];
    if (q.since !== undefined) conditions.push(gte(trade.executedAt, q.since));
    if (q.until !== undefined) conditions.push(lte(trade.executedAt, q.until));
    if (q.before !== undefined) {
      const keyset = or(
        lt(trade.executedAt, q.before.executedAt),
        and(eq(trade.executedAt, q.before.executedAt), lt(trade.tradeId, q.before.tradeId)),
      );
      if (keyset !== undefined) conditions.push(keyset);
    }
    return tx
      .select()
      .from(trade)
      .where(and(...conditions))
      .orderBy(desc(trade.executedAt), desc(trade.tradeId))
      .limit(q.limit);
  },
};
