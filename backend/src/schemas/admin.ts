/**
 * Schemas Zod del panel de administración/monitoreo (rol `admin`).
 *
 * La API habla snake_case; el controller convierte desde las vistas camelCase
 * del service. Endpoints de solo-lectura: no hay bodies, solo query + response.
 */
import { z } from "zod";
import { MARKET_ROLES } from "../types/contracts";
import { AgentStatusSchema } from "./auth";

/** Clamp silencioso del limit (mismo criterio que schemas/market §17). */
function clampedLimit(defaultLimit: number, maxLimit: number) {
  return z.coerce
    .number()
    .catch(defaultLimit)
    .default(defaultLimit)
    .transform((n) => Math.min(Math.max(Math.trunc(n), 1), maxLimit));
}

function clampedOffset() {
  return z.coerce
    .number()
    .catch(0)
    .default(0)
    .transform((n) => Math.max(Math.trunc(n), 0));
}

// ---------------------------------------------------------------------------
// GET /admin/overview
// ---------------------------------------------------------------------------

export const AdminKpisSchema = z.object({
  active_agents: z.number().int().min(0),
  bankrupt_agents: z.number().int().min(0),
  total_capital_cents: z.number().int().min(0),
  fees_collected_cents: z.number().int().min(0),
  active_processes: z.number().int().min(0),
  open_orders: z.number().int().min(0),
  trade_volume_24h: z.number().int().min(0),
  trades_24h: z.number().int().min(0),
});

export const AdminAgentsByRoleItemSchema = z.object({
  role: z.string(),
  active_agents: z.number().int().min(0),
  bankrupt_agents: z.number().int().min(0),
  total_capital_cents: z.number().int().min(0),
});

export const AdminOverviewSchema = z.object({
  kpis: AdminKpisSchema,
  by_role: z.array(AdminAgentsByRoleItemSchema),
});

export type AdminOverviewDto = z.infer<typeof AdminOverviewSchema>;

// ---------------------------------------------------------------------------
// GET /admin/agents
// ---------------------------------------------------------------------------

export const AdminAgentsQuerySchema = z.object({
  limit: clampedLimit(50, 200),
  offset: clampedOffset(),
  role: z.enum(MARKET_ROLES).optional(),
  status: AgentStatusSchema.optional(),
});

export type AdminAgentsQuery = z.infer<typeof AdminAgentsQuerySchema>;

export const AdminAgentItemSchema = z.object({
  agent_id: z.uuid(),
  username: z.string(),
  role: z.string(),
  status: z.string(),
  capital_available_cents: z.number().int().min(0),
  capital_reserved_cents: z.number().int().min(0),
  registered_at: z.iso.datetime(),
});

export const AdminAgentsPageSchema = z.object({
  items: z.array(AdminAgentItemSchema),
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  offset: z.number().int().min(0),
});

export type AdminAgentsPageDto = z.infer<typeof AdminAgentsPageSchema>;

// ---------------------------------------------------------------------------
// GET /admin/market
// ---------------------------------------------------------------------------

export const AdminMarketProductSchema = z.object({
  product_id: z.uuid(),
  name: z.string(),
  unit: z.string(),
  category: z.string(),
  best_bid_cents: z.number().int().nullable(),
  best_ask_cents: z.number().int().nullable(),
  bid_depth: z.number().int().min(0),
  ask_depth: z.number().int().min(0),
  total_inventory: z.number().int().min(0),
  trade_volume_24h: z.number().int().min(0),
  vwap_24h_cents: z.number().int().nullable(),
  trades_24h: z.number().int().min(0),
});

export const AdminMarketSchema = z.array(AdminMarketProductSchema);

export type AdminMarketProductDto = z.infer<typeof AdminMarketProductSchema>;

// ---------------------------------------------------------------------------
// GET /admin/production
// ---------------------------------------------------------------------------

export const AdminProductionRecipeSchema = z.object({
  recipe_id: z.uuid(),
  recipe_name: z.string(),
  output_product_id: z.uuid(),
  output_product_name: z.string(),
  active_processes: z.number().int().min(0),
  planned_executions: z.number().int().min(0),
  wage_paid_cents: z.number().int().min(0),
});

export const AdminProducedProductSchema = z.object({
  product_id: z.uuid(),
  name: z.string(),
  unit: z.string(),
  produced_units_24h: z.number().int().min(0),
});

export const AdminProductionSchema = z.object({
  recipes: z.array(AdminProductionRecipeSchema),
  produced: z.array(AdminProducedProductSchema),
});

export type AdminProductionDto = z.infer<typeof AdminProductionSchema>;

// ---------------------------------------------------------------------------
// GET /admin/snapshots
// ---------------------------------------------------------------------------

export const AdminSnapshotsQuerySchema = z.object({
  limit: clampedLimit(200, 1000),
});

export type AdminSnapshotsQuery = z.infer<typeof AdminSnapshotsQuerySchema>;

export const AdminSnapshotPointSchema = z.object({
  snapshot_id: z.uuid(),
  taken_at: z.iso.datetime(),
  active_agents: z.number().int().min(0),
  total_money_cents: z.number().int().min(0),
  fees_collected_cents: z.number().int().min(0),
});

export const AdminSnapshotsSchema = z.array(AdminSnapshotPointSchema);

export type AdminSnapshotPointDto = z.infer<typeof AdminSnapshotPointSchema>;
