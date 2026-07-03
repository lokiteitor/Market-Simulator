/**
 * Schemas Zod del historial propio (openapi: Event, EventPage, TradePage) — [M6 read-side].
 *
 * Paginación por cursor (contrato §17): limit default 200, max 1000 según
 * openapi para /history/*; el cursor es la PK uuidv7 (opaco por convención).
 */
import { z } from "zod";
import { eventType } from "../db/schema";
import { pageQuerySchema, pageResponseSchema } from "./common";
import { TradeSchema } from "./market";

export const EventTypeSchema = z.enum(eventType.enumValues);

export type EventTypeDto = z.infer<typeof EventTypeSchema>;

/** Evento del event_log (openapi `Event`). `agent_id` null en eventos sistémicos. */
export const EventSchema = z.object({
  event_id: z.uuid(),
  event_type: EventTypeSchema,
  agent_id: z.uuid().nullable(),
  occurred_at: z.iso.datetime(),
  payload: z.record(z.string(), z.unknown()),
});

export type EventDto = z.infer<typeof EventSchema>;

/** Query de GET /history/trades (openapi: limit 1..1000, default 200). */
export const HistoryTradesQuerySchema = pageQuerySchema(200, 1000).extend({
  side: z.enum(["buyer", "seller"]).optional(),
  product_id: z.uuid().optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

export type HistoryTradesQuery = z.infer<typeof HistoryTradesQuerySchema>;

/**
 * Query de GET /history/events. `event_type` es array en openapi; en query
 * string un único valor llega como string ⇒ se normaliza a array de uno.
 */
export const HistoryEventsQuerySchema = pageQuerySchema(200, 1000).extend({
  event_type: z.preprocess(
    (v) => (v === undefined || Array.isArray(v) ? v : [v]),
    z.array(EventTypeSchema).optional(),
  ),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

export type HistoryEventsQuery = z.infer<typeof HistoryEventsQuerySchema>;

/** openapi `TradePage`. */
export const TradePageSchema = pageResponseSchema(TradeSchema);

export type TradePageDto = z.infer<typeof TradePageSchema>;

/** openapi `EventPage`. */
export const EventPageSchema = pageResponseSchema(EventSchema);

export type EventPageDto = z.infer<typeof EventPageSchema>;
