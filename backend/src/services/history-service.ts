/**
 * Service de historial propio (lecturas puras) — [M6 read-side].
 *
 * /history/trades: trades donde el agente fue comprador O vendedor.
 * /history/events: event_log filtrado por agent_id del autenticado.
 * Paginación por cursor uuidv7 DESC (contrato §17); el cursor se valida aquí
 * con decodeCursor (malformado ⇒ DomainError invalid_cursor, 400).
 */
import { withTransaction } from "../db";
import type { EventLogRow, TradeRow } from "../db/schema";
import { decodeCursor } from "../lib/cursor";
import type { EventType } from "../lib/event-log";
import { buildPage } from "../schemas/common";
import {
  historyRepository,
  type HistoryEventsFilter,
  type HistoryTradesFilter,
} from "../repositories/history-repository";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const historyService = {
  async getTrades(
    agentId: string,
    q: {
      side?: "buyer" | "seller";
      productId?: string;
      since?: Date;
      until?: Date;
      cursor?: string;
      limit: number;
    },
  ): Promise<Page<TradeRow>> {
    const filter: HistoryTradesFilter = {
      side: q.side,
      productId: q.productId,
      since: q.since,
      until: q.until,
      cursor: q.cursor !== undefined ? decodeCursor(q.cursor) : undefined,
      limit: q.limit,
    };
    const rows = await withTransaction((tx) =>
      historyRepository.tradesForAgent(tx, agentId, filter),
    );
    return buildPage(rows, q.limit, (r) => r.tradeId);
  },

  async getEvents(
    agentId: string,
    q: {
      eventTypes?: EventType[];
      since?: Date;
      until?: Date;
      cursor?: string;
      limit: number;
    },
  ): Promise<Page<EventLogRow>> {
    const filter: HistoryEventsFilter = {
      eventTypes: q.eventTypes,
      since: q.since,
      until: q.until,
      cursor: q.cursor !== undefined ? decodeCursor(q.cursor) : undefined,
      limit: q.limit,
    };
    const rows = await withTransaction((tx) =>
      historyRepository.eventsForAgent(tx, agentId, filter),
    );
    return buildPage(rows, q.limit, (r) => r.eventId);
  },
};
