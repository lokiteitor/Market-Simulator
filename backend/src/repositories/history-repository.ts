/**
 * Repositorio de historial propio (trade, event_log) — [M6 read-side].
 *
 * Paginación por cursor sobre la PK uuidv7 (contrato §17):
 *   WHERE pk < :cursor ORDER BY pk DESC LIMIT :limit
 * El cursor llega YA validado/decodificado por el service (decodeCursor).
 */
import { and, desc, eq, gte, inArray, lt, lte, or } from "drizzle-orm";
import type { Tx } from "../db";
import { eventLog, trade, type EventLogRow, type TradeRow } from "../db/schema";

export interface HistoryTradesFilter {
  /** `buyer` | `seller`; sin filtro ⇒ ambos lados. */
  side?: "buyer" | "seller";
  productId?: string;
  since?: Date;
  until?: Date;
  /** PK decodificada (UUID) del último item de la página anterior. */
  cursor?: string;
  limit: number;
}

export interface HistoryEventsFilter {
  eventTypes?: EventLogRow["eventType"][];
  since?: Date;
  until?: Date;
  cursor?: string;
  limit: number;
}

export const historyRepository = {
  /** Trades donde el agente participó como comprador O vendedor. */
  async tradesForAgent(
    tx: Tx,
    agentId: string,
    f: HistoryTradesFilter,
  ): Promise<TradeRow[]> {
    const sideCondition =
      f.side === "buyer"
        ? eq(trade.buyerAgentId, agentId)
        : f.side === "seller"
          ? eq(trade.sellerAgentId, agentId)
          : or(eq(trade.buyerAgentId, agentId), eq(trade.sellerAgentId, agentId));

    return tx
      .select()
      .from(trade)
      .where(
        and(
          sideCondition,
          f.productId !== undefined ? eq(trade.productId, f.productId) : undefined,
          f.since !== undefined ? gte(trade.executedAt, f.since) : undefined,
          f.until !== undefined ? lte(trade.executedAt, f.until) : undefined,
          f.cursor !== undefined ? lt(trade.tradeId, f.cursor) : undefined,
        ),
      )
      .orderBy(desc(trade.tradeId))
      .limit(f.limit);
  },

  /** Eventos del event_log cuyo agent_id es el agente autenticado. */
  async eventsForAgent(
    tx: Tx,
    agentId: string,
    f: HistoryEventsFilter,
  ): Promise<EventLogRow[]> {
    return tx
      .select()
      .from(eventLog)
      .where(
        and(
          eq(eventLog.agentId, agentId),
          f.eventTypes !== undefined && f.eventTypes.length > 0
            ? inArray(eventLog.eventType, f.eventTypes)
            : undefined,
          f.since !== undefined ? gte(eventLog.occurredAt, f.since) : undefined,
          f.until !== undefined ? lte(eventLog.occurredAt, f.until) : undefined,
          f.cursor !== undefined ? lt(eventLog.eventId, f.cursor) : undefined,
        ),
      )
      .orderBy(desc(eventLog.eventId))
      .limit(f.limit);
  },
};
