/**
 * Controller de /orders — [M3 orders].
 *
 * Traduce el contrato HTTP (snake_case, openapi.yaml) ⇄ el service (camelCase).
 * No abre transacciones ni contiene reglas de negocio; los DomainError del
 * service los mapea el error handler global [M10] a Problem+JSON.
 */
import { orderService } from "../services/order-service";
import {
  orderToApi,
  tradeToApi,
  type ListOrdersQuery,
  type OrderBody,
  type OrderPageBody,
  type PlaceOrderBody,
  type PlaceOrderResponseBody,
  type TradeBody,
} from "../schemas/orders";

export type CancelOutcome =
  | { statusCode: 200; body: OrderBody }
  | { statusCode: 204; body?: undefined };

export const orderController = {
  /** POST /orders → 201 (creada) o 200 (replay idempotente §10.7). */
  async place(
    agentId: string,
    body: PlaceOrderBody,
  ): Promise<{ statusCode: 200 | 201; body: PlaceOrderResponseBody }> {
    const result = await orderService.placeOrder(agentId, {
      productId: body.product_id,
      side: body.side,
      qtyCent: body.qty_cent,
      limitPriceCents: body.limit_price_cents,
      ttlSeconds: body.ttl_seconds,
      clientOrderId: body.client_order_id,
    });
    return {
      statusCode: result.replayed ? 200 : 201,
      body: {
        ...orderToApi(result.order),
        trades_generated: result.trades.map(tradeToApi),
      },
    };
  },

  /** GET /orders → OrderPage. */
  async list(agentId: string, query: ListOrdersQuery): Promise<OrderPageBody> {
    const page = await orderService.listOrders(agentId, {
      statuses: query.status,
      productId: query.product_id,
      side: query.side,
      since: query.since !== undefined ? new Date(query.since) : undefined,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(orderToApi), next_cursor: page.nextCursor };
  },

  /** GET /orders/{order_id} → Order. */
  async get(agentId: string, orderId: string): Promise<OrderBody> {
    return orderToApi(await orderService.getOrder(agentId, orderId));
  },

  /** DELETE /orders/{order_id} → 204 (cancelada) o 200 (ya terminal, §10.11). */
  async cancel(agentId: string, orderId: string): Promise<CancelOutcome> {
    const result = await orderService.cancelOrder(agentId, orderId);
    if (result.alreadyTerminal) {
      return { statusCode: 200, body: orderToApi(result.order) };
    }
    return { statusCode: 204 };
  },

  /** GET /orders/{order_id}/trades → Trade[]. */
  async listTrades(agentId: string, orderId: string): Promise<TradeBody[]> {
    const trades = await orderService.getOrderTrades(agentId, orderId);
    return trades.map(tradeToApi);
  },
};
