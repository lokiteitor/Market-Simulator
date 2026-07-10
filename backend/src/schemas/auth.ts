/**
 * Schemas Zod de /auth/* (espejo de specs/openapi.yaml) — [M1 auth]
 *
 * La API habla snake_case; la conversión a camelCase la hace el controller.
 * Zod es la única librería de validación (ADR-016); las rutas usan
 * fastify-type-provider-zod para body y serialización de respuestas.
 */
import { z } from "zod";
import { agentRole } from "../db/schema";
import { MARKET_ROLES } from "../types/contracts";
import { UuidSchema } from "./common";

// ---------------------------------------------------------------------------
// Enums (openapi AgentRole / AgentStatus)
// ---------------------------------------------------------------------------

/**
 * Rol completo (incluye `admin`): para SERIALIZAR respuestas de agentes que
 * podrían ser un administrador (p. ej. AgentPublic). Derivado del enum de la DB.
 */
export const AgentRoleSchema = z.enum(agentRole.enumValues);

/**
 * Roles registrables vía POST /auth/register: solo los de mercado. Excluye
 * `admin` deliberadamente para que nadie pueda auto-asignarse el rol de
 * administrador por la vía pública (Zod rechaza el body con 400).
 */
export const RegisterableRoleSchema = z.enum(MARKET_ROLES);

export const AgentStatusSchema = z.enum(["active", "bankrupt"]);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** openapi RegisterAgentRequest. */
export const RegisterAgentRequestSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/, "Solo letras, dígitos y . _ -"),
  password: z.string().min(12).max(256),
  role: RegisterableRoleSchema,
  // Aceptadas por contrato openapi pero el servidor asigna las capacidades
  // según los parámetros configurados para el rol (seed-config), tal como
  // permite la descripción del campo ("las acepta o ajusta").
  requested_capacities: z
    .array(
      z.object({
        recipe_id: UuidSchema,
        installations: z.number().int().min(1),
      }),
    )
    .optional(),
});

export type RegisterAgentRequestBody = z.infer<typeof RegisterAgentRequestSchema>;

/** openapi LoginRequest. */
export const LoginRequestSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export type LoginRequestBody = z.infer<typeof LoginRequestSchema>;

/** openapi RefreshRequest (también body de /auth/logout). */
export const RefreshRequestSchema = z.object({
  refresh_token: z.string(),
});

export type RefreshRequestBody = z.infer<typeof RefreshRequestSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** openapi TokenPair. */
export const TokenPairSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal("Bearer"),
  access_expires_at: z.iso.datetime(),
  refresh_expires_at: z.iso.datetime(),
});

export type TokenPairJson = z.infer<typeof TokenPairSchema>;

/** openapi AgentPublic. */
export const AgentPublicSchema = z.object({
  agent_id: UuidSchema,
  username: z.string(),
  role: AgentRoleSchema,
  status: AgentStatusSchema,
  registered_at: z.iso.datetime(),
  bankrupt_at: z.iso.datetime().nullable(),
});

/** openapi CapacityStatus. */
export const CapacityStatusSchema = z.object({
  recipe_id: UuidSchema,
  installations: z.number().int().min(1),
  running: z.number().int().min(0),
  available_slots: z.number().int().min(0),
});

/**
 * openapi AgentSnapshot, acotado a la respuesta de register: un agente recién
 * creado no puede tener inventario, órdenes ni procesos (nacen en ESTA tx),
 * así que esas listas son siempre vacías y se tipan de forma laxa. El
 * AgentSnapshot completo (GET /agents/me) es de [M2] (src/schemas/agents.ts).
 */
export const RegisterAgentSnapshotSchema = z.object({
  agent: AgentPublicSchema,
  capital_available_cents: z.number().int().min(0),
  capital_reserved_cents: z.number().int().min(0),
  inventory: z.array(z.unknown()),
  active_orders: z.array(z.unknown()),
  running_processes: z.array(z.unknown()),
  capacities: z.array(CapacityStatusSchema),
  recent_events: z.array(z.unknown()),
});

/** openapi RegisterAgentResponse = TokenPair ∪ { agent: AgentSnapshot }. */
export const RegisterAgentResponseSchema = TokenPairSchema.extend({
  agent: RegisterAgentSnapshotSchema,
});

export type RegisterAgentResponseJson = z.infer<typeof RegisterAgentResponseSchema>;
