/**
 * Schemas Zod del contrato HTTP de /orders (openapi.yaml manda) — [M3 orders].
 *
 * La API habla snake_case; el código TS, camelCase. Los conversores
 * fila→API viven aquí (contrato §0: conversión en controllers/schemas) porque
 * también los usa el service para los payloads de notificación WS
 * (`order_executed` = objeto Trade del openapi + order_id + fill).
 */
import { z } from "zod";
import type { MarketOrderRow, TradeRow } from "../db/schema";
import { pageQuerySchema, pageResponseSchema, UuidSchema } from "./common";

export const OrderSideSchema = z.enum(["buy", "sell"]);
export const OrderStatusSchema = z.enum(["active", "partial", "completed", "cancelled", "expired"]);

// Enteros de dominio: int64 en el openapi, pero JS solo maneja enteros seguros
// (los helpers de money rechazan más allá de 2^53−1).
const positiveInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonNegativeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Body de POST /orders (openapi PlaceOrderRequest). El rango del TTL se
 * valida en el service (§10.5 ⇒ 422 ttl_out_of_range, no 400). */
export const PlaceOrderBodySchema = z.object({
  product_id: UuidSchema,
  side: OrderSideSchema,
  qty_cent: positiveInt,
  limit_price_cents: positiveInt,
  ttl_seconds: positiveInt,
  client_order_id: z.string().min(1).max(64).optional(),
});
export type PlaceOrderBody = z.infer<typeof PlaceOrderBodySchema>;

/** openapi Order. */
export const OrderResponseSchema = z.object({
  order_id: UuidSchema,
  agent_id: UuidSchema,
  product_id: UuidSchema,
  side: OrderSideSchema,
  qty_original_cent: positiveInt,
  qty_pending_cent: nonNegativeInt,
  limit_price_cents: positiveInt,
  status: OrderStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string(),
});
export type OrderBody = z.infer<typeof OrderResponseSchema>;

/** openapi Trade. */
export const TradeResponseSchema = z.object({
  trade_id: UuidSchema,
  buy_order_id: UuidSchema,
  sell_order_id: UuidSchema,
  buyer_agent_id: UuidSchema,
  seller_agent_id: UuidSchema,
  product_id: UuidSchema,
  qty_executed_cent: positiveInt,
  price_cents: positiveInt,
  fee_buyer_cents: nonNegativeInt,
  fee_seller_cents: nonNegativeInt,
  executed_at: z.string(),
});
export type TradeBody = z.infer<typeof TradeResponseSchema>;

/** openapi PlaceOrderResponse = Order + trades_generated. */
export const PlaceOrderResponseSchema = OrderResponseSchema.extend({
  trades_generated: z.array(TradeResponseSchema),
});
export type PlaceOrderResponseBody = z.infer<typeof PlaceOrderResponseSchema>;

/**
 * Query de GET /orders. `status` es repetible (?status=a&status=b): fastify
 * entrega string o string[]; se normaliza a array. `limit`: default 100,
 * max 500 (openapi), con clamp silencioso (§17).
 */
export const ListOrdersQuerySchema = pageQuerySchema(100, 500).extend({
  status: z.preprocess(
    (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]),
    z.array(OrderStatusSchema).optional(),
  ),
  product_id: UuidSchema.optional(),
  side: OrderSideSchema.optional(),
  since: z.iso.datetime({ offset: true }).optional(),
});
export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;

/** openapi OrderPage. */
export const OrderPageResponseSchema = pageResponseSchema(OrderResponseSchema);
export type OrderPageBody = z.infer<typeof OrderPageResponseSchema>;

export const OrderIdParamsSchema = z.object({ order_id: UuidSchema });
export type OrderIdParams = z.infer<typeof OrderIdParamsSchema>;

// ---------------------------------------------------------------------------
// Conversores fila (camelCase) → API (snake_case)
// ---------------------------------------------------------------------------

export function orderToApi(o: MarketOrderRow): OrderBody {
  return {
    order_id: o.orderId,
    agent_id: o.agentId,
    product_id: o.productId,
    side: o.side,
    qty_original_cent: o.qtyOriginal,
    qty_pending_cent: o.qtyPending,
    limit_price_cents: o.limitPriceCents,
    status: o.status,
    created_at: o.createdAt.toISOString(),
    updated_at: o.updatedAt.toISOString(),
    expires_at: o.expiresAt.toISOString(),
  };
}

export function tradeToApi(t: TradeRow): TradeBody {
  return {
    trade_id: t.tradeId,
    buy_order_id: t.buyOrderId,
    sell_order_id: t.sellOrderId,
    buyer_agent_id: t.buyerAgentId,
    seller_agent_id: t.sellerAgentId,
    product_id: t.productId,
    qty_executed_cent: t.qtyExecuted,
    price_cents: t.priceCents,
    fee_buyer_cents: t.feeBuyerCents,
    fee_seller_cents: t.feeSellerCents,
    executed_at: t.executedAt.toISOString(),
  };
}
