/**
 * Rutas /market/* (openapi tag `market`) — [M6 read-side].
 *
 * AUTENTICADAS: requieren Bearer (preHandler `app.authenticate`, decorado por
 * el plugin de auth [M1]). Visibilidad nivel 1 (diseño §13).
 *
 * M10 registra esta función con prefix "/v1" (contrato §15).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { marketController } from "../controllers/market-controller";
import { ProductIdParamsSchema } from "../schemas/catalog";
import {
  MarketTradesQuerySchema,
  TopOfBookSchema,
  TradeSchema,
} from "../schemas/market";

export async function registerMarketRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/market/:product_id/top",
    {
      preHandler: [app.authenticate],
      schema: {
        params: ProductIdParamsSchema,
        response: { 200: TopOfBookSchema },
      },
    },
    async (req) => marketController.getTopOfBook(req.params.product_id),
  );

  r.get(
    "/market/:product_id/trades",
    {
      preHandler: [app.authenticate],
      schema: {
        params: ProductIdParamsSchema,
        querystring: MarketTradesQuerySchema,
        response: { 200: z.array(TradeSchema) },
      },
    },
    async (req) =>
      marketController.getRecentTrades(req.params.product_id, req.query),
  );
}
