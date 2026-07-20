/**
 * Schemas Zod de instalaciones (economía de instalaciones, ADR-021).
 * snake_case en el borde HTTP; espejo del openapi.
 */
import { z } from "zod";
import { AgentRoleSchema } from "./auth";
import { InstallationStatusSchema } from "./agents";

/** Body de POST /agents/me/installations (comprar/mejorar). */
export const AcquireInstallationRequestSchema = z.object({
  installation_type: z.string().min(1),
  /**
   * Concurrencia optimista: si se envía y no coincide con el nivel actual, la
   * operación falla con conflict_state en vez de cobrar (útil para los bots).
   */
  expected_current_level: z.number().int().nonnegative().optional(),
});

export type AcquireInstallationRequest = z.infer<
  typeof AcquireInstallationRequestSchema
>;

/** Respuesta de POST: el estado nuevo + lo cobrado. */
export const AcquireInstallationResponseSchema = InstallationStatusSchema.extend({
  amount_charged_cents: z.number().int().nonnegative(),
});

export type AcquireInstallationResponseJson = z.infer<
  typeof AcquireInstallationResponseSchema
>;

/** openapi components.schemas.InstallationType (catálogo comprable). */
export const InstallationTypeSchema = z.object({
  installation_type_id: z.uuid(),
  key: z.string(),
  name: z.string(),
  role: AgentRoleSchema,
  unit_label: z.string(),
  base_price_cents: z.number().int().min(1),
  growth_bps: z.number().int().min(1),
  max_level: z.number().int().min(1),
});

export type InstallationTypeJson = z.infer<typeof InstallationTypeSchema>;

export const InstallationTypeListSchema = z.array(InstallationTypeSchema);
export const InstallationStatusListSchema = z.array(InstallationStatusSchema);
