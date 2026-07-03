/**
 * Rutas de transformaciones — [M4 transformations].
 *
 * openapi /transformations/*. El prefijo /v1 lo aplica el bootstrap [M10] vía
 * `app.register(registerTransformationRoutes, { prefix: "/v1" })`. Todas las
 * rutas requieren Bearer token (`app.authenticate`, plugin de M1).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { transformationController } from "../controllers/transformation-controller";
import {
  ListTransformationsQuerySchema,
  ProcessIdParamsSchema,
  StartTransformationRequestSchema,
  TransformationPageSchema,
  TransformationProcessDetailSchema,
  TransformationProcessSchema,
} from "../schemas/transformations";

export async function registerTransformationRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // POST /transformations — iniciar un proceso (201).
  r.post(
    "/transformations",
    {
      preHandler: [app.authenticate],
      schema: {
        body: StartTransformationRequestSchema,
        response: { 201: TransformationProcessSchema },
      },
    },
    async (request, reply) => {
      const json = await transformationController.start(request.agentId, request.body);
      return reply.code(201).send(json);
    },
  );

  // GET /transformations — listar procesos propios (200).
  r.get(
    "/transformations",
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: ListTransformationsQuerySchema,
        response: { 200: TransformationPageSchema },
      },
    },
    async (request) => transformationController.list(request.agentId, request.query),
  );

  // GET /transformations/{process_id} — detalle (200; materializa lazy antes).
  r.get(
    "/transformations/:process_id",
    {
      preHandler: [app.authenticate],
      schema: {
        params: ProcessIdParamsSchema,
        response: { 200: TransformationProcessDetailSchema },
      },
    },
    async (request) => transformationController.get(request.agentId, request.params.process_id),
  );

  // DELETE /transformations/{process_id} — cancelar (204, sin reembolsos).
  r.delete(
    "/transformations/:process_id",
    {
      preHandler: [app.authenticate],
      schema: { params: ProcessIdParamsSchema },
    },
    async (request, reply) => {
      await transformationController.cancel(request.agentId, request.params.process_id);
      return reply.code(204).send();
    },
  );
}
