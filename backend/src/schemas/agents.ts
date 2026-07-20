/**
 * Schemas Zod del módulo de agentes [M2] — contrato HTTP de `/agents/*`
 * (specs/openapi.yaml manda: snake_case, shapes y status codes).
 *
 * Los shapes embebidos en `AgentSnapshot` (Order, TransformationProcess,
 * Event) son ESPEJO de los components del openapi. Se definen localmente para
 * no acoplar la compilación de este módulo a los schemas de módulos paralelos
 * (M3/M4/M6); la fuente de verdad compartida es el openapi.
 *
 * Los enums se derivan de los pgEnum del schema Drizzle para que cualquier
 * cambio se propague automáticamente.
 */
import { z } from "zod";
import { config } from "../config";
import {
  agentRole,
  agentStatus,
  eventType,
  inventoryLotOrigin,
  orderSide,
  orderStatus,
  processStatus,
} from "../db/schema";
import { UuidSchema } from "./common";

// ---------------------------------------------------------------------------
// Enums (espejo de los pgEnum / components del openapi)
// ---------------------------------------------------------------------------

export const AgentRoleSchema = z.enum(agentRole.enumValues);
export const AgentStatusSchema = z.enum(agentStatus.enumValues);
export const InventoryLotOriginSchema = z.enum(inventoryLotOrigin.enumValues);
export const OrderSideSchema = z.enum(orderSide.enumValues);
export const OrderStatusSchema = z.enum(orderStatus.enumValues);
export const ProcessStatusSchema = z.enum(processStatus.enumValues);
export const EventTypeSchema = z.enum(eventType.enumValues);

// ---------------------------------------------------------------------------
// Componentes de respuesta
// ---------------------------------------------------------------------------

/** openapi components.schemas.AgentPublic */
export const AgentPublicSchema = z.object({
  agent_id: UuidSchema,
  username: z.string(),
  role: AgentRoleSchema,
  status: AgentStatusSchema,
  registered_at: z.string(),
  bankrupt_at: z.string().nullable(),
});

export type AgentPublicJson = z.infer<typeof AgentPublicSchema>;

/** openapi components.schemas.InventoryPosition */
export const InventoryPositionSchema = z.object({
  product_id: UuidSchema,
  qty_available_cent: z.number().int().nonnegative(),
  qty_reserved_cent: z.number().int().nonnegative(),
});

export type InventoryPositionJson = z.infer<typeof InventoryPositionSchema>;

/** openapi components.schemas.InventoryLot */
export const InventoryLotSchema = z.object({
  lot_id: UuidSchema,
  product_id: UuidSchema,
  origin: InventoryLotOriginSchema,
  qty_original_cent: z.number().int().min(1),
  qty_available_cent: z.number().int().nonnegative(),
  qty_reserved_cent: z.number().int().nonnegative(),
  unit_cost_cents: z.number().int().nonnegative(),
  acquired_at: z.string(),
  source_trade_id: UuidSchema.nullable(),
  source_process_id: UuidSchema.nullable(),
});

export type InventoryLotJson = z.infer<typeof InventoryLotSchema>;

/** openapi components.schemas.InstallationStatus (instalación comprada, ADR-021). */
export const InstallationStatusSchema = z.object({
  installation_type: z.string(),
  name: z.string(),
  unit_label: z.string(),
  level: z.number().int().min(1),
  running: z.number().int().nonnegative(),
  available_slots: z.number().int().nonnegative(),
  next_upgrade_price_cents: z.number().int().nonnegative().nullable(),
});

export type InstallationStatusJson = z.infer<typeof InstallationStatusSchema>;

/** Espejo de openapi components.schemas.Order (para active_orders del snapshot). */
export const AgentOrderSchema = z.object({
  order_id: UuidSchema,
  agent_id: UuidSchema,
  product_id: UuidSchema,
  side: OrderSideSchema,
  qty_original_cent: z.number().int().min(1),
  qty_pending_cent: z.number().int().nonnegative(),
  limit_price_cents: z.number().int().min(1),
  status: OrderStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string(),
});

export type AgentOrderJson = z.infer<typeof AgentOrderSchema>;

/** Espejo de openapi components.schemas.TransformationProcess (running_processes). */
export const AgentProcessSchema = z.object({
  process_id: UuidSchema,
  agent_id: UuidSchema,
  recipe_id: UuidSchema,
  executions_planned: z.number().int().min(1),
  current_execution: z.number().int().min(1),
  status: ProcessStatusSchema,
  wage_paid_cents: z.number().int().nonnegative(),
  started_at: z.string(),
  expected_end_at: z.string(),
  actual_end_at: z.string().nullable(),
});

export type AgentProcessJson = z.infer<typeof AgentProcessSchema>;

/** Espejo de openapi components.schemas.Event (recent_events). */
export const AgentEventSchema = z.object({
  event_id: UuidSchema,
  event_type: EventTypeSchema,
  agent_id: UuidSchema.nullable(),
  occurred_at: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

export type AgentEventJson = z.infer<typeof AgentEventSchema>;

/** openapi components.schemas.AgentSnapshot (GET /agents/me). */
export const AgentSnapshotSchema = z.object({
  agent: AgentPublicSchema,
  capital_available_cents: z.number().int().nonnegative(),
  capital_reserved_cents: z.number().int().nonnegative(),
  inventory: z.array(InventoryPositionSchema),
  active_orders: z.array(AgentOrderSchema),
  running_processes: z.array(AgentProcessSchema),
  installations: z.array(InstallationStatusSchema),
  recent_events: z.array(AgentEventSchema),
});

export type AgentSnapshotJson = z.infer<typeof AgentSnapshotSchema>;

export const InstallationStatusListSchema = z.array(InstallationStatusSchema);
export const InventoryPositionListSchema = z.array(InventoryPositionSchema);
export const InventoryLotListSchema = z.array(InventoryLotSchema);

// ---------------------------------------------------------------------------
// Parámetros de query / path
// ---------------------------------------------------------------------------

/** GET /agents/me — `events_limit` (0..1000, default RECONNECT_EVENTS_LIMIT). */
export const SelfStateQuerySchema = z.object({
  events_limit: z.coerce
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(config.reconnectEventsLimit),
});

export type SelfStateQuery = z.infer<typeof SelfStateQuerySchema>;

/** GET /agents/me/inventory — filtro opcional por producto. */
export const InventoryQuerySchema = z.object({
  product_id: UuidSchema.optional(),
});

export type InventoryQuery = z.infer<typeof InventoryQuerySchema>;

/** GET /agents/me/inventory/lots — filtro por producto + only_with_stock. */
export const InventoryLotsQuerySchema = z.object({
  product_id: UuidSchema.optional(),
  only_with_stock: z.stringbool().default(true),
});

export type InventoryLotsQuery = z.infer<typeof InventoryLotsQuerySchema>;

/** GET /agents/{agent_id}. */
export const AgentIdParamsSchema = z.object({
  agent_id: UuidSchema,
});

export type AgentIdParams = z.infer<typeof AgentIdParamsSchema>;
