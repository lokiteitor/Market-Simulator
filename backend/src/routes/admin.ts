/**
 * Rutas /admin/* (panel de monitoreo) — solo rol `admin`.
 *
 * TODAS requieren `[app.authenticate, app.requireAdmin]`: 401 sin token válido,
 * 403 si el agente autenticado no es admin. Solo-lectura (agregados globales).
 *
 * M10 registra esta función con prefix "/v1" (contrato §15) → prefijo efectivo
 * `/v1/admin`.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { adminController } from "../controllers/admin-controller";
import {
  AdminAgentsPageSchema,
  AdminAgentsQuerySchema,
  AdminMarketSchema,
  AdminOverviewSchema,
  AdminProductionSchema,
  AdminSnapshotsQuerySchema,
  AdminSnapshotsSchema,
} from "../schemas/admin";
import { ProblemSchema } from "../schemas/common";

export function registerAdminRoutes(app: FastifyInstance): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const adminOnly = { preHandler: [app.authenticate, app.requireAdmin] };
  const problems = { 401: ProblemSchema, 403: ProblemSchema };

  r.get(
    "/admin/overview",
    { ...adminOnly, schema: { response: { 200: AdminOverviewSchema, ...problems } } },
    async () => adminController.getOverview(),
  );

  r.get(
    "/admin/agents",
    {
      ...adminOnly,
      schema: {
        querystring: AdminAgentsQuerySchema,
        response: { 200: AdminAgentsPageSchema, ...problems },
      },
    },
    async (req) => adminController.listAgents(req.query),
  );

  r.get(
    "/admin/market",
    { ...adminOnly, schema: { response: { 200: AdminMarketSchema, ...problems } } },
    async () => adminController.getMarket(),
  );

  r.get(
    "/admin/production",
    { ...adminOnly, schema: { response: { 200: AdminProductionSchema, ...problems } } },
    async () => adminController.getProduction(),
  );

  r.get(
    "/admin/snapshots",
    {
      ...adminOnly,
      schema: {
        querystring: AdminSnapshotsQuerySchema,
        response: { 200: AdminSnapshotsSchema, ...problems },
      },
    },
    async (req) => adminController.getSnapshots(req.query),
  );
}
