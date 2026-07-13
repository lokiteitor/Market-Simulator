/**
 * Schemas Zod del mercado (openapi: TopOfBook, TopOfBookSide, Trade) — [M6 read-side].
 *
 * Visibilidad NIVEL 1 (diseño §13): una sola orden por lado con identidad del
 * agente; el resto del libro es privado. Los trades ejecutados son públicos.
 */
import { z } from "zod";

/** Clamp silencioso del limit, mismo criterio que schemas/common (§17). */
function clampedLimit(defaultLimit: number, maxLimit: number) {
  return z.coerce
    .number()
    .catch(defaultLimit)
    .default(defaultLimit)
    .transform((n) => Math.min(Math.max(Math.trunc(n), 1), maxLimit));
}

export const TopOfBookSideSchema = z.object({
  order_id: z.uuid(),
  agent_id: z.uuid(),
  price_cents: z.number().int().min(1),
  qty_pending_cent: z.number().int().min(1),
});

export type TopOfBookSideDto = z.infer<typeof TopOfBookSideSchema>;

export const TopOfBookSchema = z.object({
  product_id: z.uuid(),
  observed_at: z.iso.datetime(),
  best_bid: TopOfBookSideSchema.nullable(),
  best_ask: TopOfBookSideSchema.nullable(),
});

export type TopOfBookDto = z.infer<typeof TopOfBookSchema>;

/** Trade público (openapi `Trade`). `qty_executed_cent` = columna `qty_executed`. */
export const TradeSchema = z.object({
  trade_id: z.uuid(),
  buy_order_id: z.uuid(),
  sell_order_id: z.uuid(),
  buyer_agent_id: z.uuid(),
  seller_agent_id: z.uuid(),
  product_id: z.uuid(),
  qty_executed_cent: z.number().int().min(1),
  price_cents: z.number().int().min(1),
  fee_buyer_cents: z.number().int().min(0),
  fee_seller_cents: z.number().int().min(0),
  executed_at: z.iso.datetime(),
});

export type TradeDto = z.infer<typeof TradeSchema>;

/**
 * Query de GET /market/{product_id}/trades (openapi: limit 1..1000, default
 * 100). La ventana por defecto de un día SIMULADO solo aplica cuando no se
 * pasa NINGÚN filtro temporal (ni `since`, ni `until`, ni `before`):
 *   - `since`/`until`: acotan por `executed_at` (>= / <=).
 *   - `before`: cursor keyset exacto para backfill — trades estrictamente
 *     anteriores (executed_at, trade_id) al trade indicado.
 */
export const MarketTradesQuerySchema = z.object({
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  before: z.uuid().optional(),
  limit: clampedLimit(100, 1000),
});

export type MarketTradesQuery = z.infer<typeof MarketTradesQuerySchema>;
