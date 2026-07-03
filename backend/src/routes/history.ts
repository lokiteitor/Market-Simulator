/**
 * Rutas /history/* (openapi tag `history`) — [M6 read-side].
 *
 * AUTENTICADAS: consultan SOLO datos del agente del JWT (`request.agentId`,
 * decorado por el plugin de auth [M1]). Paginación por cursor (contrato §17).
 *
 * M10 registra esta función con prefix "/v1" (contrato §15).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { historyController } from "../controllers/history-controller";
import {
  EventPageSchema,
  HistoryEventsQuerySchema,
  HistoryTradesQuerySchema,
  TradePageSchema,
} from "../schemas/history";

export async function registerHistoryRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/history/trades",
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: HistoryTradesQuerySchema,
        response: { 200: TradePageSchema },
      },
    },
    async (req) => historyController.getTrades(req.agentId, req.query),
  );

  r.get(
    "/history/events",
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: HistoryEventsQuerySchema,
        response: { 200: EventPageSchema },
      },
    },
    async (req) => historyController.getEvents(req.agentId, req.query),
  );
}
