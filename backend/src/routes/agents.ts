/**
 * Rutas `/agents/*` [M2 agents] — openapi tags `agent`.
 *
 * M10 registra esta función con prefijo `/v1`:
 *   app.register(registerAgentRoutes, { prefix: "/v1" })
 * (async ⇒ funciona igual llamada directa o como plugin de Fastify).
 *
 * Todas las rutas requieren autenticación (`app.authenticate`, plugin [M1]).
 * Nota §10.14: el estado bankrupt NO bloquea estas lecturas (solo bloquea
 * escrituras de dominio, verificado en los services de escritura).
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { agentController } from "../controllers/agent-controller";
import { installationController } from "../controllers/installation-controller";
import {
  AgentIdParamsSchema,
  AgentPublicSchema,
  AgentSnapshotSchema,
  InventoryLotListSchema,
  InventoryLotsQuerySchema,
  InventoryPositionListSchema,
  InventoryQuerySchema,
  SelfStateQuerySchema,
} from "../schemas/agents";
import { ProblemSchema } from "../schemas/common";
import {
  AcquireInstallationRequestSchema,
  AcquireInstallationResponseSchema,
  InstallationStatusListSchema,
} from "../schemas/installations";

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // GET /agents/me — snapshot completo del agente autenticado.
  r.get(
    "/agents/me",
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: SelfStateQuerySchema,
        response: { 200: AgentSnapshotSchema },
      },
    },
    agentController.getMe,
  );

  // GET /agents/me/installations — instalaciones compradas (nivel + slots).
  r.get(
    "/agents/me/installations",
    {
      preHandler: [app.authenticate],
      schema: {
        response: { 200: InstallationStatusListSchema },
      },
    },
    installationController.getMine,
  );

  // POST /agents/me/installations — comprar/mejorar una instalación (ADR-021).
  r.post(
    "/agents/me/installations",
    {
      preHandler: [app.authenticate],
      schema: {
        body: AcquireInstallationRequestSchema,
        response: {
          201: AcquireInstallationResponseSchema,
          403: ProblemSchema,
          404: ProblemSchema,
          409: ProblemSchema,
          422: ProblemSchema,
        },
      },
    },
    installationController.acquire,
  );

  // GET /agents/me/inventory — posiciones agregadas por producto.
  r.get(
    "/agents/me/inventory",
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: InventoryQuerySchema,
        response: { 200: InventoryPositionListSchema },
      },
    },
    agentController.getMyInventory,
  );

  // GET /agents/me/inventory/lots — detalle por lote (FIFO).
  r.get(
    "/agents/me/inventory/lots",
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: InventoryLotsQuerySchema,
        response: { 200: InventoryLotListSchema },
      },
    },
    agentController.getMyInventoryLots,
  );

  // GET /agents/{agent_id} — información pública de cualquier agente.
  r.get(
    "/agents/:agent_id",
    {
      preHandler: [app.authenticate],
      schema: {
        params: AgentIdParamsSchema,
        response: { 200: AgentPublicSchema, 404: ProblemSchema },
      },
    },
    agentController.getAgentPublic,
  );
}
