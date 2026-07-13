/**
 * Service de transformaciones — [M4 transformations].
 *
 * Implementa el ciclo de vida completo de los procesos (contrato §§4, 10.4,
 * 10.8-10.10 y openapi /transformations/*):
 *   - startTransformation: validación atómica + salario upfront + consumo de
 *     insumos FIFO con trazabilidad.
 *   - cancelTransformation: sin reembolsos; evalúa quiebra.
 *   - getProcess / listProcesses: current_execution CALCULADA (§10.9).
 *   - TransformationMaterializer (§8): materialización lazy (FOR UPDATE) y
 *     sweep global (FOR UPDATE SKIP LOCKED + LIMIT); abren su PROPIA tx y
 *     publican notificaciones SOLO post-commit.
 */
import { withTransaction, type Tx } from "../db";
import type {
  InventoryLotRow,
  TransformationLotConsumptionRow,
  TransformationProcessRow,
} from "../db/schema";
import { decodeCursor } from "../lib/cursor";
import { DomainError, domainError } from "../lib/errors";
import {
  appendEvent,
  type DepositDepletedPayload,
  type ProcessCancelledPayload,
  type ProcessCompletedPayload,
  type ProcessStartedPayload,
} from "../lib/event-log";
import { clampMint } from "../lib/gold";
import { unitCostFromTotal } from "../lib/money";
import {
  intervalToSimSeconds,
  processExpectedEndAt,
  realMsToSimSeconds,
  wageCentsForProcess,
} from "../lib/simtime";
import { publishBroadcast, publishToAgent, type Notification } from "../notifier";
import { logger } from "../observability/logger";
import { productionUnitsTotal } from "../observability/metrics";
import { productLabels } from "../observability/product-names";
import { depositRepository } from "../repositories/deposit-repository";
import {
  transformationRepository as repo,
  type ProcessStatus,
} from "../repositories/transformation-repository";
import { buildPage } from "../schemas/common";
import type { TransformationMaterializer } from "../types/contracts";
import { bankruptcyService } from "./bankruptcy-service";
import { inventoryService } from "./inventory-service";

// =============================================================================
// Helpers PUROS (testeables sin DB — tests/unit/transformations)
// =============================================================================

/**
 * Salario total de un proceso (§4):
 * wage_rate_cents_per_sec × intervalToSimSeconds(duration) × executions.
 * Enteros con producto exacto (BigInt) vía wageCentsForProcess.
 */
export function processWageCents(
  durationInterval: string,
  wageRateCentsPerSec: number,
  executionsPlanned: number,
): number {
  const durationSimSeconds = intervalToSimSeconds(durationInterval);
  return wageCentsForProcess(wageRateCentsPerSec, durationSimSeconds, executionsPlanned);
}

/**
 * current_execution calculada (§10.9): el avance NO se persiste en vivo; al
 * leer un proceso running se calcula
 *   min(executions_planned, floor(elapsedSimSeconds / durationSimSeconds) + 1)
 * Para procesos terminales devuelve el valor persistido (completed ⇒
 * executions_planned, fijado al materializar; cancelled ⇒ el valor congelado).
 */
export function currentExecutionAt(
  p: Pick<
    TransformationProcessRow,
    "status" | "startedAt" | "executionsPlanned" | "currentExecution"
  >,
  durationSimSeconds: number,
  now: Date,
): number {
  if (p.status !== "running") return p.currentExecution;
  if (durationSimSeconds <= 0) return Math.min(p.executionsPlanned, 1);
  const elapsedSimSeconds = realMsToSimSeconds(
    Math.max(0, now.getTime() - p.startedAt.getTime()),
  );
  return Math.min(p.executionsPlanned, Math.floor(elapsedSimSeconds / durationSimSeconds) + 1);
}

/**
 * Costo total de los insumos consumidos, en centavos (§10.8):
 * floor(Σ(qty_consumed_cent × unit_cost_cents) / 100) — un ÚNICO floor sobre
 * la suma exacta en BigInt (qty está en centésimas de unidad; unit_cost por
 * unidad entera).
 */
export function inputsTotalCostCents(
  consumptions: Array<{ qtyConsumed: number; unitCostCents: number }>,
): number {
  let total = 0n;
  for (const c of consumptions) {
    if (!Number.isSafeInteger(c.qtyConsumed) || !Number.isSafeInteger(c.unitCostCents)) {
      throw new Error(
        `inputsTotalCostCents: valores no enteros seguros (${c.qtyConsumed}, ${c.unitCostCents})`,
      );
    }
    total += BigInt(c.qtyConsumed) * BigInt(c.unitCostCents);
  }
  const cents = Number(total / 100n);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`inputsTotalCostCents: total fuera de rango seguro (${total})`);
  }
  return cents;
}

/** Producto exacto qty × executions con verificación de rango seguro. */
export function qtyTimesExecutions(qtyCent: number, executions: number): number {
  if (!Number.isSafeInteger(qtyCent) || !Number.isSafeInteger(executions)) {
    throw new Error(`qtyTimesExecutions: argumentos no enteros seguros (${qtyCent}, ${executions})`);
  }
  const product = BigInt(qtyCent) * BigInt(executions);
  const n = Number(product);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`qtyTimesExecutions: producto fuera de rango seguro (${product})`);
  }
  return n;
}

// =============================================================================
// Tipos del service
// =============================================================================

export interface StartTransformationInput {
  recipeId: string;
  executionsPlanned: number;
}

export interface ListProcessesInput {
  statuses?: ProcessStatus[];
  recipeId?: string;
  /** Filtra started_at >= since. */
  since?: Date;
  /** Cursor opaco tal como llegó del cliente (se decodifica aquí). */
  cursor?: string;
  limit: number;
}

export interface TransformationProcessDetail {
  /** Fila del proceso con current_execution ya calculada (§10.9). */
  process: TransformationProcessRow;
  inputsConsumed: TransformationLotConsumptionRow[];
  producedLot: InventoryLotRow | null;
}

export interface TransformationService extends TransformationMaterializer {
  startTransformation(
    agentId: string,
    input: StartTransformationInput,
  ): Promise<TransformationProcessRow>;
  cancelTransformation(agentId: string, processId: string): Promise<void>;
  getProcess(agentId: string, processId: string): Promise<TransformationProcessDetail>;
  listProcesses(
    agentId: string,
    input: ListProcessesInput,
  ): Promise<{ items: TransformationProcessRow[]; nextCursor: string | null }>;
}

// =============================================================================
// Notificaciones post-commit (contrato §0/§9: NUNCA dentro de la tx)
// =============================================================================

interface BankruptcyNotice {
  agentId: string;
  username: string;
}

interface MaterializedProcess {
  agentId: string;
  completedAt: Date;
  payload: ProcessCompletedPayload;
  bankruptcy: BankruptcyNotice | null;
}

/**
 * Publica sin propagar errores: las notificaciones son post-commit y
 * best-effort (espejo de safePublish en order-service). Un fallo del notifier
 * (p. ej. Redis caído) NUNCA debe convertir en 500 una lectura cuyo commit ya
 * ocurrió (GET /agents/me, GET /transformations/{id}), ni marcar failed el job
 * del sweeper, ni abortar el resto de un batch de notificaciones.
 */
async function safePublish(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn({ err, what }, "fallo publicando notificación post-commit");
  }
}

async function publishBankruptcy(b: BankruptcyNotice): Promise<void> {
  const occurredAt = new Date().toISOString();
  const payload = { agent_id: b.agentId, username: b.username };
  await safePublish("bankruptcy_notice", () =>
    publishToAgent(b.agentId, {
      type: "bankruptcy_notice",
      occurred_at: occurredAt,
      payload,
    }),
  );
  await safePublish("agent_bankrupt", () =>
    publishBroadcast({ type: "agent_bankrupt", occurred_at: occurredAt, payload }),
  );
}

async function publishMaterialized(results: MaterializedProcess[]): Promise<void> {
  for (const r of results) {
    // Métrica de negocio (post-commit: solo producción ya persistida).
    productionUnitsTotal.inc(
      await productLabels(r.payload.output_product_id),
      r.payload.qty_produced_cent,
    );
    const n: Notification = {
      type: "transformation_completed",
      occurred_at: r.completedAt.toISOString(),
      payload: r.payload,
    };
    await safePublish("transformation_completed", () => publishToAgent(r.agentId, n));
    if (r.bankruptcy !== null) {
      await publishBankruptcy(r.bankruptcy);
    }
  }
}

// =============================================================================
// Materialización (§10.8 — EXACTA)
// =============================================================================

/**
 * Materializa UN proceso vencido (la fila llega bloqueada FOR UPDATE):
 *   - lote production: qty = output_qty × executions_planned,
 *     unit_cost = unitCostFromTotal(Σ(consumos qty×unit_cost) + wage_paid, qty)
 *   - status='completed', actual_end_at=now(), current_execution=executions_planned
 *   - appendEvent(process_completed) y BankruptcyService.checkAndApply.
 * Devuelve los datos para notificar post-commit (el caller publica).
 */
async function materializeProcess(
  tx: Tx,
  proc: TransformationProcessRow,
): Promise<MaterializedProcess> {
  const rec = await repo.findRecipeById(tx, proc.recipeId);
  if (rec === undefined) {
    // Imposible con la FK de transformation_process.recipe_id; invariante roto.
    throw new Error(`materializeProcess: receta ${proc.recipeId} inexistente`);
  }
  const consumptions = await repo.getConsumptions(tx, proc.processId);
  const totalCostCents = inputsTotalCostCents(consumptions) + proc.wagePaidCents;
  const qtyPlannedCent = qtyTimesExecutions(rec.outputQty, proc.executionsPlanned);

  // Yacimiento finito (patrón oro): si el producto de salida tiene
  // resource_deposit, la producción se CLAMPEA a lo que queda (min(remaining,
  // planificado)) y el remanente se decrementa en la MISMA tx. Orden de locks:
  // proceso (ya bloqueado por el caller) → depósito. Si el clamp deja 0, no se
  // crea lote (CHECK qty_original > 0): el salario/insumos se pierden, igual
  // que en una cancelación (política sin reembolsos).
  let qtyProducedCent = qtyPlannedCent;
  let depositDepleted: DepositDepletedPayload | null = null;
  const deposit = await depositRepository.lockDeposit(tx, rec.outputProductId);
  if (deposit !== undefined) {
    const { mintedQtyCent, remainingAfterCent } = clampMint(
      deposit.qtyRemainingCent,
      qtyPlannedCent,
    );
    qtyProducedCent = mintedQtyCent;
    if (mintedQtyCent > 0) {
      const ok = await depositRepository.decrement(tx, rec.outputProductId, mintedQtyCent);
      if (!ok) {
        // Inalcanzable: la fila está bloqueada FOR UPDATE y el clamp ya acotó.
        throw new Error(
          `materializeProcess: decremento del depósito de ${rec.outputProductId} falló`,
        );
      }
    }
    if (remainingAfterCent === 0 && deposit.qtyRemainingCent > 0) {
      depositDepleted = {
        product_id: rec.outputProductId,
        qty_initial_cent: deposit.qtyInitialCent,
        process_id: proc.processId,
      };
    }
  }

  let outputLotId: string | null = null;
  if (qtyProducedCent > 0) {
    outputLotId = await inventoryService.createLot(tx, {
      agentId: proc.agentId,
      productId: rec.outputProductId,
      origin: "production",
      qtyCent: qtyProducedCent,
      unitCostCents: unitCostFromTotal(totalCostCents, qtyProducedCent),
      sourceProcessId: proc.processId,
    });
  }

  const completedAt = new Date();
  await repo.completeProcess(tx, proc.processId, completedAt);

  const payload: ProcessCompletedPayload = {
    process_id: proc.processId,
    agent_id: proc.agentId,
    recipe_id: proc.recipeId,
    output_product_id: rec.outputProductId,
    qty_produced_cent: qtyProducedCent,
    output_lot_id: outputLotId,
  };
  await appendEvent(tx, { type: "process_completed", agentId: proc.agentId, payload });
  if (depositDepleted !== null) {
    // Evento del sistema (sin agentId): el yacimiento es global.
    await appendEvent(tx, { type: "deposit_depleted", payload: depositDepleted });
  }

  // §8: llamar tras la transición terminal, DENTRO de la misma tx. El caller
  // publica bankruptcy_notice + agent_bankrupt post-commit si devolvió true.
  let bankruptcy: BankruptcyNotice | null = null;
  if (await bankruptcyService.checkAndApply(tx, proc.agentId)) {
    const agentRow = await repo.findAgent(tx, proc.agentId);
    bankruptcy = { agentId: proc.agentId, username: agentRow?.username ?? "" };
  }

  return { agentId: proc.agentId, completedAt, payload, bankruptcy };
}

/** Materialización lazy de los vencidos del agente (FOR UPDATE, sin SKIP). */
async function materializeExpiredForAgent(agentId: string): Promise<number> {
  const results = await withTransaction(async (tx) => {
    const expired = await repo.findExpiredForAgentForUpdate(tx, agentId);
    const out: MaterializedProcess[] = [];
    for (const proc of expired) {
      out.push(await materializeProcess(tx, proc));
    }
    return out;
  });
  await publishMaterialized(results);
  if (results.length > 0) {
    logger.debug({ agentId, count: results.length }, "procesos materializados (lazy)");
  }
  return results.length;
}

/** Sweep global del worker (FOR UPDATE SKIP LOCKED, LIMIT batch). */
async function materializeExpiredGlobal(limit: number): Promise<number> {
  const results = await withTransaction(async (tx) => {
    const expired = await repo.findExpiredGlobalSkipLocked(tx, limit);
    const out: MaterializedProcess[] = [];
    for (const proc of expired) {
      out.push(await materializeProcess(tx, proc));
    }
    return out;
  });
  await publishMaterialized(results);
  if (results.length > 0) {
    logger.debug({ count: results.length }, "procesos materializados (sweep)");
  }
  return results.length;
}

// =============================================================================
// Operaciones de dominio
// =============================================================================

/**
 * Inicia un proceso (§10.4, openapi POST /transformations), en UNA transacción:
 *   1. Lock del agente (FOR UPDATE) — serializa por agente; bankrupt ⇒ 403.
 *   2. Receta existe ⇒ si no, 404 unknown_recipe.
 *   3. Capacidad: sin fila ⇒ insufficient_capacity; COUNT(running) >=
 *      installations ⇒ recipe_capacity_saturated.
 *   4. Salario upfront (§4) con UPDATE condicional (§10.3) ⇒ insufficient_capital.
 *   5. Insumos × executions consumidos vía consumeAvailableFifo (⇒
 *      insufficient_inventory) con trazabilidad en transformation_lot_consumption.
 *   6. INSERT proceso (expected_end_at = processExpectedEndAt) +
 *      appendEvent(process_started).
 */
async function startTransformation(
  agentId: string,
  input: StartTransformationInput,
): Promise<TransformationProcessRow> {
  const { recipeId, executionsPlanned } = input;
  // Materialización lazy ANTES de validar capacidad (diseño §5): procesos ya
  // vencidos no deben contar como running en countRunning. Abre su propia tx
  // y commitea antes del lockAgent (mismo patrón que getProcess) — sin riesgo
  // de deadlock.
  await materializeExpiredForAgent(agentId);
  return withTransaction(async (tx) => {
    const agentRow = await repo.lockAgent(tx, agentId);
    if (agentRow === undefined) {
      throw domainError("unknown_agent", `El agente ${agentId} no existe.`);
    }
    if (agentRow.status === "bankrupt") {
      throw domainError("agent_bankrupt", "El agente está en quiebra y no puede operar.");
    }

    const found = await repo.findRecipeWithInputs(tx, recipeId);
    if (found === undefined) {
      // openapi manda: POST /transformations enumera unknown_recipe como causa
      // 422 y no declara 404 (el 404 queda para GET /catalog/recipes/{id}).
      throw new DomainError({
        code: "unknown_recipe",
        status: 422,
        title: "Receta desconocida",
        detail: `La receta ${recipeId} no existe.`,
        field: "recipe_id",
      });
    }

    // Fail-fast del yacimiento finito: si el producto de salida tiene depósito
    // agotado, iniciar el proceso solo quemaría salario/insumos para producir
    // 0 (el clamp de materializeProcess). Sin lock: la carrera residual entre
    // este check y la materialización la resuelve el clamp.
    const remaining = await depositRepository.getRemaining(tx, found.recipe.outputProductId);
    if (remaining === 0) {
      throw domainError(
        "resource_depleted",
        `El yacimiento del producto ${found.recipe.outputProductId} está agotado; la receta ya no puede producir.`,
        { field: "recipe_id" },
      );
    }

    const installations = await repo.getInstallations(tx, agentId, recipeId);
    if (installations === undefined) {
      throw domainError(
        "insufficient_capacity",
        `El agente no tiene capacidad instalada para la receta ${recipeId}.`,
        { field: "recipe_id" },
      );
    }
    const running = await repo.countRunning(tx, agentId, recipeId);
    if (running >= installations) {
      throw domainError(
        "recipe_capacity_saturated",
        `Capacidad saturada para la receta: ${running}/${installations} procesos en curso.`,
        { field: "recipe_id" },
      );
    }

    const durationSimSeconds = intervalToSimSeconds(found.recipe.duration);
    const wagePaidCents = wageCentsForProcess(
      found.recipe.wageRateCentsPerSec,
      durationSimSeconds,
      executionsPlanned,
    );
    const deducted = await repo.deductCapitalAvailable(tx, agentId, wagePaidCents);
    if (!deducted) {
      throw domainError(
        "insufficient_capital",
        `Capital disponible insuficiente para pagar el salario upfront de ${wagePaidCents} centavos.`,
      );
    }

    // Consumo real (no reserva) de insumos × executions, FIFO por lote (M5).
    // consumeAvailableFifo lanza insufficient_inventory si no alcanza.
    const consumptionRows: Array<{
      lotId: string;
      productId: string;
      qtyConsumed: number;
      unitCostCents: number;
    }> = [];
    for (const inputRow of found.inputs) {
      const qtyNeeded = qtyTimesExecutions(inputRow.qtyRequired, executionsPlanned);
      const consumed = await inventoryService.consumeAvailableFifo(
        tx,
        agentId,
        inputRow.productId,
        qtyNeeded,
      );
      for (const c of consumed) {
        consumptionRows.push({
          lotId: c.lotId,
          productId: inputRow.productId,
          qtyConsumed: c.qtyCent,
          unitCostCents: c.unitCostCents,
        });
      }
    }

    const startedAt = new Date();
    const expectedEndAt = processExpectedEndAt(startedAt, durationSimSeconds, executionsPlanned);
    const proc = await repo.insertProcess(tx, {
      agentId,
      recipeId,
      executionsPlanned,
      wagePaidCents,
      startedAt,
      expectedEndAt,
    });
    await repo.insertLotConsumptions(
      tx,
      consumptionRows.map((c) => ({ processId: proc.processId, ...c })),
    );

    const payload: ProcessStartedPayload = {
      process_id: proc.processId,
      agent_id: agentId,
      recipe_id: recipeId,
      executions: executionsPlanned,
      wage_paid_cents: wagePaidCents,
      expected_end_at: proc.expectedEndAt.toISOString(),
    };
    await appendEvent(tx, { type: "process_started", agentId, payload });

    return proc;
  });
}

/**
 * Cancela un proceso running del propio agente (§10.10): SIN reembolsos (ni
 * insumos ni salario), actual_end_at=now(), appendEvent(process_cancelled) y
 * BankruptcyService dentro de la tx; notificaciones de quiebra post-commit.
 */
async function cancelTransformation(agentId: string, processId: string): Promise<void> {
  // La finalización es por timestamp (diseño §5/§7): un proceso con
  // expected_end_at vencido YA devengó su producción aunque el sweeper aún no
  // lo haya tocado. Materializar primero ⇒ el DELETE de un vencido responde
  // 409 conflict_state (vía la validación de status) en vez de destruir el lote.
  await materializeExpiredForAgent(agentId);
  const bankruptcy = await withTransaction(async (tx) => {
    const proc = await repo.findProcessByIdForUpdate(tx, processId);
    if (proc === undefined) {
      throw domainError("unknown_process", `El proceso ${processId} no existe.`);
    }
    if (proc.agentId !== agentId) {
      throw domainError("not_owner", "El proceso pertenece a otro agente.");
    }
    const agentRow = await repo.findAgent(tx, agentId);
    if (agentRow !== undefined && agentRow.status === "bankrupt") {
      throw domainError("agent_bankrupt", "El agente está en quiebra y no puede operar.");
    }
    if (proc.status !== "running") {
      throw domainError(
        "conflict_state",
        `El proceso ya está en estado terminal (${proc.status}).`,
      );
    }
    // Defensa en-tx para la ventana residual de ms entre la materialización
    // lazy de arriba y el FOR UPDATE: un proceso vencido no es cancelable
    // (el sweeper o la próxima lectura lo materializará).
    if (proc.expectedEndAt.getTime() <= Date.now()) {
      throw domainError(
        "conflict_state",
        "El proceso ya alcanzó su expected_end_at y su producción está devengada; no puede cancelarse.",
      );
    }

    const cancelled = await repo.cancelProcess(tx, processId, new Date());
    if (!cancelled) {
      // Inalcanzable: la fila está bloqueada FOR UPDATE y era running.
      throw domainError("conflict_state", "El proceso ya no está en curso.");
    }
    const payload: ProcessCancelledPayload = { process_id: processId, agent_id: agentId };
    await appendEvent(tx, { type: "process_cancelled", agentId, payload });

    if (await bankruptcyService.checkAndApply(tx, agentId)) {
      return { agentId, username: agentRow?.username ?? "" } satisfies BankruptcyNotice;
    }
    return null;
  });
  if (bankruptcy !== null) {
    await publishBankruptcy(bankruptcy);
  }
}

/**
 * Detalle de un proceso propio (openapi GET /transformations/{id}):
 * materializa lazy los vencidos del agente ANTES de leer; incluye consumos
 * (trazabilidad) y el lote producido si completó. current_execution §10.9.
 */
async function getProcess(
  agentId: string,
  processId: string,
): Promise<TransformationProcessDetail> {
  await materializeExpiredForAgent(agentId);
  return withTransaction(async (tx) => {
    const proc = await repo.findProcessById(tx, processId);
    if (proc === undefined) {
      throw domainError("unknown_process", `El proceso ${processId} no existe.`);
    }
    if (proc.agentId !== agentId) {
      throw domainError("not_owner", "El proceso pertenece a otro agente.");
    }
    const inputsConsumed = await repo.getConsumptions(tx, processId);
    const producedLot = (await repo.findProducedLot(tx, processId)) ?? null;

    let currentExecution = proc.currentExecution;
    if (proc.status === "running") {
      const rec = await repo.findRecipeById(tx, proc.recipeId);
      const durationSimSeconds = rec !== undefined ? intervalToSimSeconds(rec.duration) : 0;
      currentExecution = currentExecutionAt(proc, durationSimSeconds, new Date());
    }
    return { process: { ...proc, currentExecution }, inputsConsumed, producedLot };
  });
}

/**
 * Listado propio con filtros y cursor (openapi GET /transformations, §17).
 * Materializa lazy los vencidos del agente ANTES de leer (diseño §5: "en TODA
 * lectura de estado del agente"), como getProcess y GET /agents/me.
 */
async function listProcesses(
  agentId: string,
  input: ListProcessesInput,
): Promise<{ items: TransformationProcessRow[]; nextCursor: string | null }> {
  await materializeExpiredForAgent(agentId);
  const cursor = input.cursor !== undefined ? decodeCursor(input.cursor) : undefined;
  return withTransaction(async (tx) => {
    const filter: Parameters<typeof repo.listByAgent>[2] = { limit: input.limit };
    if (input.statuses !== undefined) filter.statuses = input.statuses;
    if (input.recipeId !== undefined) filter.recipeId = input.recipeId;
    if (input.since !== undefined) filter.since = input.since;
    if (cursor !== undefined) filter.cursor = cursor;
    const rows = await repo.listByAgent(tx, agentId, filter);

    // current_execution calculada solo para los running (§10.9).
    const runningRecipeIds = [
      ...new Set(rows.filter((r) => r.status === "running").map((r) => r.recipeId)),
    ];
    const recipes = await repo.findRecipesByIds(tx, runningRecipeIds);
    const durationByRecipe = new Map(
      recipes.map((r) => [r.recipeId, intervalToSimSeconds(r.duration)]),
    );
    const now = new Date();
    const items = rows.map((r) =>
      r.status === "running"
        ? {
            ...r,
            currentExecution: currentExecutionAt(r, durationByRecipe.get(r.recipeId) ?? 0, now),
          }
        : r,
    );
    return buildPage(items, input.limit, (r) => r.processId);
  });
}

// =============================================================================
// Singleton (contrato §8: los services se exportan como objetos singleton)
// =============================================================================

export const transformationService: TransformationService = {
  startTransformation,
  cancelTransformation,
  getProcess,
  listProcesses,
  materializeExpiredForAgent,
  materializeExpiredGlobal,
};
