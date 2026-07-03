/**
 * Controller de historial propio: filas → DTOs snake_case del openapi
 * (TradePage, EventPage) — [M6 read-side].
 */
import type { EventLogRow } from "../db/schema";
import type {
  EventDto,
  EventPageDto,
  HistoryEventsQuery,
  HistoryTradesQuery,
  TradePageDto,
} from "../schemas/history";
import { historyService } from "../services/history-service";
import { toTradeDto } from "./market-controller";

export function toEventDto(row: EventLogRow): EventDto {
  return {
    event_id: row.eventId,
    event_type: row.eventType,
    agent_id: row.agentId,
    occurred_at: row.occurredAt.toISOString(),
    // jsonb libre por event_type; nuestros payloads (contrato §9) son siempre
    // objetos snake_case.
    payload: row.payload as Record<string, unknown>,
  };
}

export const historyController = {
  async getTrades(agentId: string, q: HistoryTradesQuery): Promise<TradePageDto> {
    const page = await historyService.getTrades(agentId, {
      side: q.side,
      productId: q.product_id,
      since: q.since,
      until: q.until,
      cursor: q.cursor,
      limit: q.limit,
    });
    return {
      items: page.items.map(toTradeDto),
      next_cursor: page.nextCursor,
    };
  },

  async getEvents(agentId: string, q: HistoryEventsQuery): Promise<EventPageDto> {
    const page = await historyService.getEvents(agentId, {
      eventTypes: q.event_type,
      since: q.since,
      until: q.until,
      cursor: q.cursor,
      limit: q.limit,
    });
    return {
      items: page.items.map(toEventDto),
      next_cursor: page.nextCursor,
    };
  },
};
