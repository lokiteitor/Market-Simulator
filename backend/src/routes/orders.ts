/**
 * Rutas de /orders (openapi.yaml manda) — [M3 orders].
 *
 * [M10] las registra con `app.register(registerOrderRoutes, { prefix: "/v1" })`.
 * Todas requieren autenticación: `app.authenticate` (plugin [M1]) setea
 * `request.agentId` (module augmentation en src/auth/types.d.ts).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { orderController } from "../controllers/order-controller";
import {
  ListOrdersQuerySchema,
  OrderIdParamsSchema,
  OrderPageResponseSchema,
  OrderResponseSchema,
  PlaceOrderBodySchema,
  PlaceOrderResponseSchema,
  TradeResponseSchema,
} from "../schemas/orders";

export function registerOrderRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // POST /orders — colocar orden (201; 200 en replay idempotente §10.7).
  r.route({
    method: "POST",
    url: "/orders",
    preHandler: app.authenticate,
    schema: {
      body: PlaceOrderBodySchema,
      response: {
        200: PlaceOrderResponseSchema,
        201: PlaceOrderResponseSchema,
      },
    },
    handler: async (request, reply) => {
      const res = await orderController.place(request.agentId, request.body);
      return reply.code(res.statusCode).send(res.body);
    },
  });

  // GET /orders — listar órdenes propias (por defecto activas/parciales).
  r.route({
    method: "GET",
    url: "/orders",
    preHandler: app.authenticate,
    schema: {
      querystring: ListOrdersQuerySchema,
      response: { 200: OrderPageResponseSchema },
    },
    handler: async (request) => orderController.list(request.agentId, request.query),
  });

  // GET /orders/{order_id} — detalle de una orden propia.
  r.route({
    method: "GET",
    url: "/orders/:order_id",
    preHandler: app.authenticate,
    schema: {
      params: OrderIdParamsSchema,
      response: { 200: OrderResponseSchema },
    },
    handler: async (request) => orderController.get(request.agentId, request.params.order_id),
  });

  // DELETE /orders/{order_id} — cancelar (204) / ya terminal (200, §10.11).
  r.route({
    method: "DELETE",
    url: "/orders/:order_id",
    preHandler: app.authenticate,
    schema: {
      params: OrderIdParamsSchema,
      // 204 sin body: Fastify descarta el payload en 204 (send(null) satisface
      // el tipo del serializer).
      response: { 200: OrderResponseSchema, 204: z.null() },
    },
    handler: async (request, reply) => {
      const res = await orderController.cancel(request.agentId, request.params.order_id);
      if (res.statusCode === 200) {
        return reply.code(200).send(res.body);
      }
      return reply.code(204).send(null);
    },
  });

  // GET /orders/{order_id}/trades — trades de una orden propia.
  r.route({
    method: "GET",
    url: "/orders/:order_id/trades",
    preHandler: app.authenticate,
    schema: {
      params: OrderIdParamsSchema,
      response: { 200: z.array(TradeResponseSchema) },
    },
    handler: async (request) =>
      orderController.listTrades(request.agentId, request.params.order_id),
  });
}
