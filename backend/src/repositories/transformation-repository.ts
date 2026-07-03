/**
 * Repositorio de procesos de transformación — [M4 transformations].
 *
 * Contrato §0: recibe `tx` (cliente transaccional) como primer parámetro y
 * NUNCA abre transacciones propias; eso es responsabilidad del service.
 *
 * Cubre (contrato §§4, 10.3, 10.4, 10.8-10.10):
 *   - inserts de proceso y de consumos (transformation_lot_consumption),
 *   - lecturas con datos para verificar ownership en el service,
 *   - COUNT de procesos running por (agent, recipe) para capacidad,
 *   - vencidos FOR UPDATE (lazy) y FOR UPDATE SKIP LOCKED + LIMIT (sweeper),
 *   - descuento condicional de capital (§10.3) y lock del agente (§10.4).
 */
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { Tx } from "../db";
import {
  agent,
  agentCapacity,
  inventoryLot,
  recipe,
  recipeInput,
  transformationLotConsumption,
  transformationProcess,
  type AgentRow,
  type InventoryLotRow,
  type RecipeInputRow,
  type RecipeRow,
  type TransformationLotConsumptionRow,
  type TransformationProcessRow,
} from "../db/schema";

/** Estado de proceso, derivado del tipo de fila del schema. */
export type ProcessStatus = TransformationProcessRow["status"];

export interface NewProcess {
  agentId: string;
  recipeId: string;
  executionsPlanned: number;
  wagePaidCents: number;
  startedAt: Date;
  expectedEndAt: Date;
}

export interface NewLotConsumption {
  processId: string;
  lotId: string;
  productId: string;
  qtyConsumed: number;
  unitCostCents: number;
}

export interface ListProcessesFilter {
  statuses?: ProcessStatus[];
  recipeId?: string;
  /** Filtra por started_at >= since. */
  since?: Date;
  /** PK decodificada; pagina con process_id < cursor (§17). */
  cursor?: string;
  limit: number;
}

export const transformationRepository = {
  /**
   * SELECT … FOR UPDATE del agente: serializa la creación de procesos por
   * agente (§10.4). Devuelve la fila para validar status (bankrupt).
   */
  async lockAgent(tx: Tx, agentId: string): Promise<AgentRow | undefined> {
    const rows = await tx
      .select()
      .from(agent)
      .where(eq(agent.agentId, agentId))
      .for("update");
    return rows[0];
  },

  /** Lectura simple del agente (status y username para notificaciones). */
  async findAgent(tx: Tx, agentId: string): Promise<AgentRow | undefined> {
    const rows = await tx.select().from(agent).where(eq(agent.agentId, agentId));
    return rows[0];
  },

  async findRecipeById(tx: Tx, recipeId: string): Promise<RecipeRow | undefined> {
    const rows = await tx.select().from(recipe).where(eq(recipe.recipeId, recipeId));
    return rows[0];
  },

  /** Receta + insumos (orden determinista por product_id para el consumo FIFO). */
  async findRecipeWithInputs(
    tx: Tx,
    recipeId: string,
  ): Promise<{ recipe: RecipeRow; inputs: RecipeInputRow[] } | undefined> {
    const rows = await tx.select().from(recipe).where(eq(recipe.recipeId, recipeId));
    const rec = rows[0];
    if (rec === undefined) return undefined;
    const inputs = await tx
      .select()
      .from(recipeInput)
      .where(eq(recipeInput.recipeId, recipeId))
      .orderBy(asc(recipeInput.productId));
    return { recipe: rec, inputs };
  },

  async findRecipesByIds(tx: Tx, recipeIds: string[]): Promise<RecipeRow[]> {
    if (recipeIds.length === 0) return [];
    return tx.select().from(recipe).where(inArray(recipe.recipeId, recipeIds));
  },

  /**
   * Instalaciones del agente para la receta. `undefined` = sin fila de
   * capacidad (⇒ insufficient_capacity en el service, §10.4).
   */
  async getInstallations(
    tx: Tx,
    agentId: string,
    recipeId: string,
  ): Promise<number | undefined> {
    const rows = await tx
      .select({ installations: agentCapacity.installations })
      .from(agentCapacity)
      .where(and(eq(agentCapacity.agentId, agentId), eq(agentCapacity.recipeId, recipeId)));
    return rows[0]?.installations;
  },

  /** COUNT de procesos running del (agent, recipe) — paralelismo por capacidad (§10.4). */
  async countRunning(tx: Tx, agentId: string, recipeId: string): Promise<number> {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(transformationProcess)
      .where(
        and(
          eq(transformationProcess.agentId, agentId),
          eq(transformationProcess.recipeId, recipeId),
          eq(transformationProcess.status, "running"),
        ),
      );
    return rows[0]?.n ?? 0;
  },

  /**
   * Descuento atómico de capital (§10.3): UPDATE condicional
   * `capital_available >= $x`; false (0 filas) ⇒ insufficient_capital.
   * Nunca check-then-act separado.
   */
  async deductCapitalAvailable(tx: Tx, agentId: string, amountCents: number): Promise<boolean> {
    const rows = await tx
      .update(agent)
      .set({ capitalAvailable: sql`${agent.capitalAvailable} - ${amountCents}` })
      .where(and(eq(agent.agentId, agentId), gte(agent.capitalAvailable, amountCents)))
      .returning({ agentId: agent.agentId });
    return rows.length > 0;
  },

  async insertProcess(tx: Tx, p: NewProcess): Promise<TransformationProcessRow> {
    const rows = await tx
      .insert(transformationProcess)
      .values({
        agentId: p.agentId,
        recipeId: p.recipeId,
        executionsPlanned: p.executionsPlanned,
        wagePaidCents: p.wagePaidCents,
        startedAt: p.startedAt,
        expectedEndAt: p.expectedEndAt,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("transformation_process: INSERT … RETURNING no devolvió filas");
    }
    return row;
  },

  /** Trazabilidad de insumos consumidos al iniciar (transformation_lot_consumption). */
  async insertLotConsumptions(tx: Tx, rows: NewLotConsumption[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.insert(transformationLotConsumption).values(
      rows.map((r) => ({
        processId: r.processId,
        lotId: r.lotId,
        productId: r.productId,
        qtyConsumed: r.qtyConsumed,
        unitCostCents: r.unitCostCents,
      })),
    );
  },

  async findProcessById(tx: Tx, processId: string): Promise<TransformationProcessRow | undefined> {
    const rows = await tx
      .select()
      .from(transformationProcess)
      .where(eq(transformationProcess.processId, processId));
    return rows[0];
  },

  /** Lock de la fila del proceso (cancelación §10.10: evita carrera con el sweeper). */
  async findProcessByIdForUpdate(
    tx: Tx,
    processId: string,
  ): Promise<TransformationProcessRow | undefined> {
    const rows = await tx
      .select()
      .from(transformationProcess)
      .where(eq(transformationProcess.processId, processId))
      .for("update");
    return rows[0];
  },

  /** Consumos registrados de un proceso (orden determinista por lot_id). */
  async getConsumptions(tx: Tx, processId: string): Promise<TransformationLotConsumptionRow[]> {
    return tx
      .select()
      .from(transformationLotConsumption)
      .where(eq(transformationLotConsumption.processId, processId))
      .orderBy(asc(transformationLotConsumption.lotId));
  },

  /** Lote producido por el proceso (origin='production'), si ya materializó. */
  async findProducedLot(tx: Tx, processId: string): Promise<InventoryLotRow | undefined> {
    const rows = await tx
      .select()
      .from(inventoryLot)
      .where(eq(inventoryLot.sourceProcessId, processId));
    return rows[0];
  },

  /** Listado propio con filtros; paginación DESC por process_id (§17). */
  async listByAgent(
    tx: Tx,
    agentId: string,
    f: ListProcessesFilter,
  ): Promise<TransformationProcessRow[]> {
    const conditions = [eq(transformationProcess.agentId, agentId)];
    if (f.statuses !== undefined && f.statuses.length > 0) {
      conditions.push(inArray(transformationProcess.status, f.statuses));
    }
    if (f.recipeId !== undefined) {
      conditions.push(eq(transformationProcess.recipeId, f.recipeId));
    }
    if (f.since !== undefined) {
      conditions.push(gte(transformationProcess.startedAt, f.since));
    }
    if (f.cursor !== undefined) {
      conditions.push(lt(transformationProcess.processId, f.cursor));
    }
    return tx
      .select()
      .from(transformationProcess)
      .where(and(...conditions))
      .orderBy(desc(transformationProcess.processId))
      .limit(f.limit);
  },

  /**
   * Procesos vencidos del agente, FOR UPDATE sin SKIP (materialización lazy,
   * §10.8): si el sweeper los tiene bloqueados, espera y luego no-opea porque
   * el status ya no es 'running' al releer… la fila devuelta aquí ya refleja
   * el estado committed tras adquirir el lock, así que el filtro es correcto.
   */
  async findExpiredForAgentForUpdate(tx: Tx, agentId: string): Promise<TransformationProcessRow[]> {
    return tx
      .select()
      .from(transformationProcess)
      .where(
        and(
          eq(transformationProcess.agentId, agentId),
          eq(transformationProcess.status, "running"),
          lte(transformationProcess.expectedEndAt, sql`now()`),
        ),
      )
      .orderBy(asc(transformationProcess.expectedEndAt), asc(transformationProcess.processId))
      .for("update");
  },

  /**
   * Sweep global: vencidos de cualquier agente, FOR UPDATE SKIP LOCKED con
   * LIMIT batch (§10.8) — no choca con materializaciones lazy concurrentes.
   */
  async findExpiredGlobalSkipLocked(tx: Tx, limit: number): Promise<TransformationProcessRow[]> {
    return tx
      .select()
      .from(transformationProcess)
      .where(
        and(
          eq(transformationProcess.status, "running"),
          lte(transformationProcess.expectedEndAt, sql`now()`),
        ),
      )
      .orderBy(asc(transformationProcess.expectedEndAt), asc(transformationProcess.processId))
      .limit(limit)
      .for("update", { skipLocked: true });
  },

  /**
   * Materializa el cierre del proceso (§10.8/§10.9): status='completed',
   * actual_end_at y current_execution = executions_planned.
   */
  async completeProcess(tx: Tx, processId: string, actualEndAt: Date): Promise<void> {
    await tx
      .update(transformationProcess)
      .set({
        status: "completed",
        actualEndAt,
        currentExecution: sql`${transformationProcess.executionsPlanned}`,
      })
      .where(eq(transformationProcess.processId, processId));
  },

  /**
   * running → cancelled (§10.10). Devuelve false si la fila ya no estaba
   * running (carrera improbable: el caller la tiene bloqueada FOR UPDATE).
   */
  async cancelProcess(tx: Tx, processId: string, actualEndAt: Date): Promise<boolean> {
    const rows = await tx
      .update(transformationProcess)
      .set({ status: "cancelled", actualEndAt })
      .where(
        and(
          eq(transformationProcess.processId, processId),
          eq(transformationProcess.status, "running"),
        ),
      )
      .returning({ processId: transformationProcess.processId });
    return rows.length > 0;
  },
};
