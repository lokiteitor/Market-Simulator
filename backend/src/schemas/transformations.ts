/**
 * Schemas Zod del módulo de transformaciones — [M4 transformations].
 *
 * Espejan los schemas de specs/openapi.yaml (snake_case en el borde HTTP):
 * StartTransformationRequest, TransformationProcess, TransformationProcessDetail,
 * LotConsumption, InventoryLot (produced_lot) y TransformationPage.
 */
import { z } from "zod";
import { pageQuerySchema, pageResponseSchema, UuidSchema } from "./common";

/** openapi ProcessStatus. */
export const ProcessStatusSchema = z.enum(["running", "completed", "cancelled"]);
export type ProcessStatusJson = z.infer<typeof ProcessStatusSchema>;

/** openapi StartTransformationRequest. Máximo = int4 (columna executions_planned). */
export const StartTransformationRequestSchema = z.object({
  recipe_id: UuidSchema,
  executions_planned: z.number().int().min(1).max(2_147_483_647),
});
export type StartTransformationRequest = z.infer<typeof StartTransformationRequestSchema>;

/** Parámetro de path {process_id}. */
export const ProcessIdParamsSchema = z.object({
  process_id: UuidSchema,
});
export type ProcessIdParams = z.infer<typeof ProcessIdParamsSchema>;

/**
 * Query de GET /transformations (openapi: limit default 100, max 500; el
 * clamp del límite es silencioso, §17). `status` acepta valor único o
 * repetido y se normaliza a array.
 */
export const ListTransformationsQuerySchema = pageQuerySchema(100, 500).extend({
  status: z
    .union([ProcessStatusSchema, z.array(ProcessStatusSchema)])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  recipe_id: UuidSchema.optional(),
  since: z.coerce.date().optional(),
});
export type ListTransformationsQuery = z.infer<typeof ListTransformationsQuerySchema>;

/** openapi TransformationProcess (respuesta; fechas ISO 8601). */
export const TransformationProcessSchema = z.object({
  process_id: UuidSchema,
  agent_id: UuidSchema,
  recipe_id: UuidSchema,
  executions_planned: z.number().int().min(1),
  current_execution: z.number().int().min(1),
  status: ProcessStatusSchema,
  wage_paid_cents: z.number().int().min(0),
  started_at: z.string(),
  expected_end_at: z.string(),
  actual_end_at: z.string().nullable(),
});
export type TransformationProcessJson = z.infer<typeof TransformationProcessSchema>;

/** openapi LotConsumption (insumos consumidos, con snapshot del unit_cost). */
export const LotConsumptionSchema = z.object({
  lot_id: UuidSchema,
  product_id: UuidSchema,
  qty_consumed_cent: z.number().int().min(1),
  unit_cost_cents: z.number().int().min(0),
});
export type LotConsumptionJson = z.infer<typeof LotConsumptionSchema>;

/** openapi InventoryLot — usado aquí como `produced_lot` del detalle. */
export const ProducedLotSchema = z.object({
  lot_id: UuidSchema,
  product_id: UuidSchema,
  origin: z.enum(["initial", "production", "purchase"]),
  qty_original_cent: z.number().int().min(1),
  qty_available_cent: z.number().int().min(0),
  qty_reserved_cent: z.number().int().min(0),
  unit_cost_cents: z.number().int().min(0),
  acquired_at: z.string(),
  source_trade_id: UuidSchema.nullable(),
  source_process_id: UuidSchema.nullable(),
});
export type ProducedLotJson = z.infer<typeof ProducedLotSchema>;

/** openapi TransformationProcessDetail (allOf proceso + trazabilidad). */
export const TransformationProcessDetailSchema = TransformationProcessSchema.extend({
  inputs_consumed: z.array(LotConsumptionSchema),
  produced_lot: ProducedLotSchema.nullable(),
});
export type TransformationProcessDetailJson = z.infer<typeof TransformationProcessDetailSchema>;

/** openapi TransformationPage: { items, next_cursor }. */
export const TransformationPageSchema = pageResponseSchema(TransformationProcessSchema);
export type TransformationPageJson = z.infer<typeof TransformationPageSchema>;
