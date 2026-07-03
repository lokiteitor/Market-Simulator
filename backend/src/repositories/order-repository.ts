/**
 * Repositorio de órdenes (market_order) — [M3 orders].
 *
 * Queries tipadas con Drizzle; recibe SIEMPRE `tx` como primer parámetro
 * (las transacciones se abren solo en services, contrato §0). La query de
 * mejor contraparte está diseñada para usar los índices parciales
 * idx_orderbook_buy / idx_orderbook_sell del schema.
 */
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, ne, sql } from "drizzle-orm";
import type { Tx } from "../db";
import { marketOrder, type MarketOrderRow } from "../db/schema";

export type OrderSide = MarketOrderRow["side"];
export type OrderStatus = MarketOrderRow["status"];

/** Estados "vivos" en el libro (casables / cancelables / expirables). */
export const OPEN_ORDER_STATUSES: readonly OrderStatus[] = ["active", "partial"] as const;

export function isOpenStatus(status: OrderStatus): boolean {
  return status === "active" || status === "partial";
}

export interface InsertOrderParams {
  agentId: string;
  productId: string;
  side: OrderSide;
  qtyCent: number;
  limitPriceCents: number;
  expiresAt: Date;
}

export interface ListOrdersFilter {
  statuses: readonly OrderStatus[];
  productId?: string | undefined;
  side?: OrderSide | undefined;
  /** created_at >= since. */
  since?: Date | undefined;
  /** Cursor decodificado (§17): order_id < beforeId. */
  beforeId?: string | undefined;
  limit: number;
}

export interface FindCounterParams {
  productId: string;
  takerSide: OrderSide;
  takerLimitPriceCents: number;
  /** Sin self-trade: se excluyen órdenes del propio agente. */
  takerAgentId: string;
}

export const orderRepository = {
  /** Inserta la orden en estado `active` con qty_pending = qty_original. */
  async insertOrder(tx: Tx, p: InsertOrderParams): Promise<MarketOrderRow> {
    const rows = await tx
      .insert(marketOrder)
      .values({
        agentId: p.agentId,
        productId: p.productId,
        side: p.side,
        qtyOriginal: p.qtyCent,
        qtyPending: p.qtyCent,
        limitPriceCents: p.limitPriceCents,
        status: "active",
        expiresAt: p.expiresAt,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("market_order: INSERT no devolvió fila");
    }
    return row;
  },

  async getById(tx: Tx, orderId: string): Promise<MarketOrderRow | undefined> {
    const rows = await tx
      .select()
      .from(marketOrder)
      .where(eq(marketOrder.orderId, orderId))
      .limit(1);
    return rows[0];
  },

  /** Lectura con lock de fila (cancelación §10.11). */
  async getByIdForUpdate(tx: Tx, orderId: string): Promise<MarketOrderRow | undefined> {
    const rows = await tx
      .select()
      .from(marketOrder)
      .where(eq(marketOrder.orderId, orderId))
      .limit(1)
      .for("update");
    return rows[0];
  },

  /**
   * Mejor contraparte compatible (§10.1), con FOR UPDATE:
   *   - taker buy : sells con limit ≤ mi limit, orden precio ASC, created_at ASC.
   *   - taker sell: buys  con limit ≥ mi limit, orden precio DESC, created_at ASC.
   *   - status IN ('active','partial') AND expires_at > now() AND agent_id != yo.
   * Desempate final por order_id ASC (uuidv7 ≈ orden de llegada) para
   * determinismo cuando created_at empata al microsegundo.
   */
  async findBestCounterForUpdate(tx: Tx, p: FindCounterParams): Promise<MarketOrderRow | undefined> {
    const counterSide: OrderSide = p.takerSide === "buy" ? "sell" : "buy";
    const priceCond =
      p.takerSide === "buy"
        ? lte(marketOrder.limitPriceCents, p.takerLimitPriceCents)
        : gte(marketOrder.limitPriceCents, p.takerLimitPriceCents);
    const priceOrder =
      p.takerSide === "buy"
        ? asc(marketOrder.limitPriceCents)
        : desc(marketOrder.limitPriceCents);
    const rows = await tx
      .select()
      .from(marketOrder)
      .where(
        and(
          eq(marketOrder.productId, p.productId),
          eq(marketOrder.side, counterSide),
          inArray(marketOrder.status, [...OPEN_ORDER_STATUSES]),
          priceCond,
          gt(marketOrder.expiresAt, sql`now()`),
          ne(marketOrder.agentId, p.takerAgentId),
        ),
      )
      .orderBy(priceOrder, asc(marketOrder.createdAt), asc(marketOrder.orderId))
      .limit(1)
      .for("update");
    return rows[0];
  },

  /** Actualiza qty_pending/status/updated_at tras un fill (§10.1). */
  async applyFill(
    tx: Tx,
    orderId: string,
    qtyPendingAfterCent: number,
    status: OrderStatus,
  ): Promise<void> {
    await tx
      .update(marketOrder)
      .set({ qtyPending: qtyPendingAfterCent, status, updatedAt: sql`now()` })
      .where(eq(marketOrder.orderId, orderId));
  },

  /**
   * Transición terminal (cancelled/expired). qty_pending se conserva tal cual
   * (el historial permite reconstruir cuánto quedó sin ejecutar).
   */
  async markTerminal(
    tx: Tx,
    orderId: string,
    status: "cancelled" | "expired",
  ): Promise<MarketOrderRow> {
    const rows = await tx
      .update(marketOrder)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(marketOrder.orderId, orderId))
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`market_order: markTerminal no encontró la orden ${orderId}`);
    }
    return row;
  },

  /**
   * Lock de una orden SOLO si sigue viva y ya venció (sweep §10.6). El
   * re-chequeo de `expires_at <= now()` y status se hace en el WHERE del
   * SELECT FOR UPDATE, de modo que una orden casada/cancelada entre la
   * selección de candidatas y este lock simplemente no aparece.
   */
  async lockOpenExpired(tx: Tx, orderId: string): Promise<MarketOrderRow | undefined> {
    const rows = await tx
      .select()
      .from(marketOrder)
      .where(
        and(
          eq(marketOrder.orderId, orderId),
          inArray(marketOrder.status, [...OPEN_ORDER_STATUSES]),
          lte(marketOrder.expiresAt, sql`now()`),
        ),
      )
      .limit(1)
      .for("update");
    return rows[0];
  },

  /**
   * IDs de órdenes vivas ya vencidas (candidatas del sweep §10.6). Sin lock:
   * cada una se re-verifica con `lockOpenExpired` en su propia transacción
   * corta. Usa el índice parcial idx_order_expiring.
   */
  async findExpiredCandidateIds(tx: Tx, limit: number): Promise<string[]> {
    const rows = await tx
      .select({ orderId: marketOrder.orderId })
      .from(marketOrder)
      .where(
        and(
          inArray(marketOrder.status, [...OPEN_ORDER_STATUSES]),
          lte(marketOrder.expiresAt, sql`now()`),
        ),
      )
      .orderBy(asc(marketOrder.expiresAt))
      .limit(limit);
    return rows.map((r) => r.orderId);
  },

  /** Órdenes del agente con filtros del openapi y paginación por cursor (§17). */
  async listForAgent(tx: Tx, agentId: string, f: ListOrdersFilter): Promise<MarketOrderRow[]> {
    const conds = [
      eq(marketOrder.agentId, agentId),
      inArray(marketOrder.status, [...f.statuses]),
    ];
    if (f.productId !== undefined) conds.push(eq(marketOrder.productId, f.productId));
    if (f.side !== undefined) conds.push(eq(marketOrder.side, f.side));
    if (f.since !== undefined) conds.push(gte(marketOrder.createdAt, f.since));
    if (f.beforeId !== undefined) conds.push(lt(marketOrder.orderId, f.beforeId));
    return tx
      .select()
      .from(marketOrder)
      .where(and(...conds))
      .orderBy(desc(marketOrder.orderId))
      .limit(f.limit);
  },
};
