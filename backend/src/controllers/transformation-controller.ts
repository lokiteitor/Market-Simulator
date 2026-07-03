/**
 * Controller de transformaciones — [M4 transformations].
 *
 * Capa de conversión entre el borde HTTP (snake_case, openapi) y el service
 * (camelCase, contrato §0). No contiene lógica de dominio.
 */
import type {
  InventoryLotRow,
  TransformationLotConsumptionRow,
  TransformationProcessRow,
} from "../db/schema";
import type {
  ListTransformationsQuery,
  LotConsumptionJson,
  ProducedLotJson,
  StartTransformationRequest,
  TransformationPageJson,
  TransformationProcessDetailJson,
  TransformationProcessJson,
} from "../schemas/transformations";
import { transformationService } from "../services/transformation-service";

/** Fila de proceso → openapi TransformationProcess (fechas ISO 8601). */
export function toProcessJson(row: TransformationProcessRow): TransformationProcessJson {
  return {
    process_id: row.processId,
    agent_id: row.agentId,
    recipe_id: row.recipeId,
    executions_planned: row.executionsPlanned,
    current_execution: row.currentExecution,
    status: row.status,
    wage_paid_cents: row.wagePaidCents,
    started_at: row.startedAt.toISOString(),
    expected_end_at: row.expectedEndAt.toISOString(),
    actual_end_at: row.actualEndAt !== null ? row.actualEndAt.toISOString() : null,
  };
}

function toLotConsumptionJson(row: TransformationLotConsumptionRow): LotConsumptionJson {
  return {
    lot_id: row.lotId,
    product_id: row.productId,
    qty_consumed_cent: row.qtyConsumed,
    unit_cost_cents: row.unitCostCents,
  };
}

function toProducedLotJson(row: InventoryLotRow): ProducedLotJson {
  return {
    lot_id: row.lotId,
    product_id: row.productId,
    origin: row.origin,
    qty_original_cent: row.qtyOriginal,
    qty_available_cent: row.qtyAvailable,
    qty_reserved_cent: row.qtyReserved,
    unit_cost_cents: row.unitCostCents,
    acquired_at: row.acquiredAt.toISOString(),
    source_trade_id: row.sourceTradeId,
    source_process_id: row.sourceProcessId,
  };
}

export const transformationController = {
  /** POST /transformations → 201 TransformationProcess. */
  async start(
    agentId: string,
    body: StartTransformationRequest,
  ): Promise<TransformationProcessJson> {
    const row = await transformationService.startTransformation(agentId, {
      recipeId: body.recipe_id,
      executionsPlanned: body.executions_planned,
    });
    return toProcessJson(row);
  },

  /** GET /transformations → 200 TransformationPage. */
  async list(
    agentId: string,
    query: ListTransformationsQuery,
  ): Promise<TransformationPageJson> {
    const input: Parameters<typeof transformationService.listProcesses>[1] = {
      limit: query.limit,
    };
    if (query.status !== undefined) input.statuses = query.status;
    if (query.recipe_id !== undefined) input.recipeId = query.recipe_id;
    if (query.since !== undefined) input.since = query.since;
    if (query.cursor !== undefined) input.cursor = query.cursor;
    const { items, nextCursor } = await transformationService.listProcesses(agentId, input);
    return { items: items.map(toProcessJson), next_cursor: nextCursor };
  },

  /** GET /transformations/{process_id} → 200 TransformationProcessDetail. */
  async get(agentId: string, processId: string): Promise<TransformationProcessDetailJson> {
    const detail = await transformationService.getProcess(agentId, processId);
    return {
      ...toProcessJson(detail.process),
      inputs_consumed: detail.inputsConsumed.map(toLotConsumptionJson),
      produced_lot: detail.producedLot !== null ? toProducedLotJson(detail.producedLot) : null,
    };
  },

  /** DELETE /transformations/{process_id} → 204. */
  async cancel(agentId: string, processId: string): Promise<void> {
    await transformationService.cancelTransformation(agentId, processId);
  },
};
