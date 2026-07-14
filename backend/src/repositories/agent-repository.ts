/**
 * Repositorio de agentes [M2 agents] — contrato §§2, 10.3, 10.12.
 *
 * Todas las funciones reciben `tx` como primer parámetro; las transacciones se
 * abren SOLO en services (contrato §0).
 *
 * REGLA §10.3 (no negociable): los descuentos de capital son SIEMPRE un
 * UPDATE condicional atómico
 *   `SET capital_available = capital_available - $x
 *    WHERE agent_id = $id AND capital_available >= $x`
 * con verificación de filas afectadas (0 ⇒ DomainError insufficient_capital).
 * Nunca check-then-act separado.
 *
 * Este repositorio también encapsula las lecturas/updates de tablas ajenas
 * (market_order, transformation_process, event_log, recipe) que el módulo M2
 * necesita para el snapshot de `/agents/me` y para BankruptcyService, sin
 * depender de nombres internos de los repos de M3/M4 (que se implementan en
 * paralelo y cuyo API interno no está fijado por el contrato).
 */
import { and, asc, desc, eq, gte, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import type { Tx } from "../db";
import {
  agent,
  agentCapacity,
  eventLog,
  marketOrder,
  recipe,
  transformationProcess,
  type AgentRow,
  type EventLogRow,
  type MarketOrderRow,
  type TransformationProcessRow,
} from "../db/schema";
import { domainError } from "../lib/errors";
import { NON_MARKET_ROLES } from "../types/contracts";

/** Fila de proceso running acompañada del INTERVAL de su receta (string pg). */
export interface RunningProcessWithDuration {
  process: TransformationProcessRow;
  /** INTERVAL de la receta tal como lo devuelve postgres.js (tiempo simulado). */
  duration: string;
}

/** Capacidad instalada + conteo de procesos running de esa receta. */
export interface CapacityWithRunning {
  recipeId: string;
  installations: number;
  running: number;
}

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} debe ser un entero seguro >= 0; recibido: ${value}`);
  }
}

export const agentRepository = {
  // -------------------------------------------------------------------------
  // Lecturas de agent
  // -------------------------------------------------------------------------

  async findById(tx: Tx, agentId: string): Promise<AgentRow | undefined> {
    const rows = await tx.select().from(agent).where(eq(agent.agentId, agentId)).limit(1);
    return rows[0];
  },

  /** Lock pesimista de la fila del agente (serializa quiebra/procesos §10.4). */
  async findByIdForUpdate(tx: Tx, agentId: string): Promise<AgentRow | undefined> {
    const rows = await tx
      .select()
      .from(agent)
      .where(eq(agent.agentId, agentId))
      .limit(1)
      .for("update");
    return rows[0];
  },

  async findByUsername(tx: Tx, username: string): Promise<AgentRow | undefined> {
    const rows = await tx.select().from(agent).where(eq(agent.username, username)).limit(1);
    return rows[0];
  },

  /**
   * floor(promedio de capital TOTAL (available+reserved) de agentes activos),
   * o `null` si no hay agentes activos (§10.12).
   */
  async averageActiveTotalCapitalCents(tx: Tx): Promise<number | null> {
    const rows = await tx
      .select({
        avg: sql<
          string | number | null
        >`floor(avg(${agent.capitalAvailable} + ${agent.capitalReserved}))::bigint`,
      })
      .from(agent)
      // Excluir roles no-mercado: admin (solo-monitoreo, capital 0) y bank
      // (sus reservas son política monetaria, no capital de mercado).
      // Fuente única: NON_MARKET_ROLES (types/contracts).
      .where(and(eq(agent.status, "active"), notInArray(agent.role, [...NON_MARKET_ROLES])));
    const value = rows[0]?.avg;
    return value === null || value === undefined ? null : Number(value);
  },

  // -------------------------------------------------------------------------
  // Escrituras de agent
  // -------------------------------------------------------------------------

  async insertAgent(
    tx: Tx,
    p: { username: string; role: AgentRow["role"]; seedCapitalCents: number },
  ): Promise<AgentRow> {
    const rows = await tx
      .insert(agent)
      .values({
        username: p.username,
        role: p.role,
        capitalAvailable: p.seedCapitalCents,
        capitalReserved: 0,
        seedCapital: p.seedCapitalCents,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("agent insert returned no rows");
    }
    return row;
  },

  async insertCapacities(
    tx: Tx,
    agentId: string,
    capacities: Array<{ recipeId: string; installations: number }>,
  ): Promise<void> {
    if (capacities.length === 0) return;
    await tx.insert(agentCapacity).values(
      capacities.map((c) => ({
        agentId,
        recipeId: c.recipeId,
        installations: c.installations,
      })),
    );
  },

  async updateAgentCapitalAndSeed(tx: Tx, agentId: string, cents: number): Promise<void> {
    assertNonNegativeInt(cents, "cents");
    await tx
      .update(agent)
      .set({
        capitalAvailable: cents,
        seedCapital: cents,
      })
      .where(eq(agent.agentId, agentId));
  },

  /**
   * Débito atómico de capital_available (§10.3).
   * 0 filas afectadas ⇒ DomainError insufficient_capital (422).
   */
  async debitAvailable(tx: Tx, agentId: string, cents: number): Promise<void> {
    assertNonNegativeInt(cents, "cents");
    if (cents === 0) return;
    const rows = await tx
      .update(agent)
      .set({ capitalAvailable: sql`${agent.capitalAvailable} - ${cents}` })
      .where(and(eq(agent.agentId, agentId), gte(agent.capitalAvailable, cents)))
      .returning({ agentId: agent.agentId });
    if (rows.length === 0) {
      throw domainError(
        "insufficient_capital",
        `Capital disponible insuficiente para debitar ${cents} centavos.`,
      );
    }
  },

  /** Abono a capital_available (no puede fallar por saldo). */
  async creditAvailable(tx: Tx, agentId: string, cents: number): Promise<void> {
    assertNonNegativeInt(cents, "cents");
    if (cents === 0) return;
    const rows = await tx
      .update(agent)
      .set({ capitalAvailable: sql`${agent.capitalAvailable} + ${cents}` })
      .where(eq(agent.agentId, agentId))
      .returning({ agentId: agent.agentId });
    if (rows.length === 0) {
      throw new Error(`creditAvailable: agente ${agentId} no existe`);
    }
  },

  /**
   * Mueve capital available → reserved (reserva de orden de compra, §5).
   * Atómico condicional: 0 filas ⇒ insufficient_capital.
   */
  async reserveCapital(tx: Tx, agentId: string, cents: number): Promise<void> {
    assertNonNegativeInt(cents, "cents");
    if (cents === 0) return;
    const rows = await tx
      .update(agent)
      .set({
        capitalAvailable: sql`${agent.capitalAvailable} - ${cents}`,
        capitalReserved: sql`${agent.capitalReserved} + ${cents}`,
      })
      .where(and(eq(agent.agentId, agentId), gte(agent.capitalAvailable, cents)))
      .returning({ agentId: agent.agentId });
    if (rows.length === 0) {
      throw domainError(
        "insufficient_capital",
        `Capital disponible insuficiente para reservar ${cents} centavos.`,
      );
    }
  },

  /**
   * Devuelve capital reserved → available (liberación §5). El telescopio de
   * liberaciones garantiza que la reserva alcanza; si no alcanza es una
   * violación de invariante (error interno, no error de dominio).
   */
  async releaseReserved(tx: Tx, agentId: string, cents: number): Promise<void> {
    assertNonNegativeInt(cents, "cents");
    if (cents === 0) return;
    const rows = await tx
      .update(agent)
      .set({
        capitalAvailable: sql`${agent.capitalAvailable} + ${cents}`,
        capitalReserved: sql`${agent.capitalReserved} - ${cents}`,
      })
      .where(and(eq(agent.agentId, agentId), gte(agent.capitalReserved, cents)))
      .returning({ agentId: agent.agentId });
    if (rows.length === 0) {
      throw new Error(
        `releaseReserved: invariante violado — capital_reserved < ${cents} para agente ${agentId}`,
      );
    }
  },

  /**
   * Débito atómico de capital_reserved (pago de un fill de compra, §5:
   * el costo sale del monto previamente reservado).
   */
  async debitReserved(tx: Tx, agentId: string, cents: number): Promise<void> {
    assertNonNegativeInt(cents, "cents");
    if (cents === 0) return;
    const rows = await tx
      .update(agent)
      .set({ capitalReserved: sql`${agent.capitalReserved} - ${cents}` })
      .where(and(eq(agent.agentId, agentId), gte(agent.capitalReserved, cents)))
      .returning({ agentId: agent.agentId });
    if (rows.length === 0) {
      throw new Error(
        `debitReserved: invariante violado — capital_reserved < ${cents} para agente ${agentId}`,
      );
    }
  },

  /** Marca al agente como bankrupt con bankrupt_at = now() (§10.13). */
  async markBankrupt(tx: Tx, agentId: string): Promise<void> {
    await tx
      .update(agent)
      .set({ status: "bankrupt", bankruptAt: new Date() })
      .where(eq(agent.agentId, agentId));
  },

  // -------------------------------------------------------------------------
  // Capacidades (con conteo de procesos running por receta)
  // -------------------------------------------------------------------------

  async getCapacityStatus(tx: Tx, agentId: string): Promise<CapacityWithRunning[]> {
    const caps = await tx
      .select()
      .from(agentCapacity)
      .where(eq(agentCapacity.agentId, agentId))
      .orderBy(asc(agentCapacity.recipeId));
    if (caps.length === 0) return [];
    const counts = await tx
      .select({
        recipeId: transformationProcess.recipeId,
        running: sql<number>`count(*)::int`,
      })
      .from(transformationProcess)
      .where(
        and(
          eq(transformationProcess.agentId, agentId),
          eq(transformationProcess.status, "running"),
        ),
      )
      .groupBy(transformationProcess.recipeId);
    const runningByRecipe = new Map(counts.map((c) => [c.recipeId, c.running]));
    return caps.map((c) => ({
      recipeId: c.recipeId,
      installations: c.installations,
      running: runningByRecipe.get(c.recipeId) ?? 0,
    }));
  },

  // -------------------------------------------------------------------------
  // Catálogo (resolución de capacidades del seed-config §10.12)
  // -------------------------------------------------------------------------

  /** Mapa name → recipe_id para los nombres dados (los que existan). */
  async findRecipeIdsByNames(tx: Tx, names: string[]): Promise<Map<string, string>> {
    if (names.length === 0) return new Map();
    const rows = await tx
      .select({ recipeId: recipe.recipeId, name: recipe.name })
      .from(recipe)
      .where(inArray(recipe.name, names));
    return new Map(rows.map((r) => [r.name, r.recipeId]));
  },

  // -------------------------------------------------------------------------
  // Órdenes del agente (snapshot /agents/me y quiebra)
  // -------------------------------------------------------------------------

  async listActiveOrders(tx: Tx, agentId: string): Promise<MarketOrderRow[]> {
    return tx
      .select()
      .from(marketOrder)
      .where(
        and(eq(marketOrder.agentId, agentId), inArray(marketOrder.status, ["active", "partial"])),
      )
      .orderBy(asc(marketOrder.createdAt), asc(marketOrder.orderId));
  },

  /** Variante FOR UPDATE para la cancelación residual de la quiebra. */
  async listActiveOrdersForUpdate(tx: Tx, agentId: string): Promise<MarketOrderRow[]> {
    return tx
      .select()
      .from(marketOrder)
      .where(
        and(eq(marketOrder.agentId, agentId), inArray(marketOrder.status, ["active", "partial"])),
      )
      .orderBy(asc(marketOrder.createdAt), asc(marketOrder.orderId))
      .for("update");
  },

  async countActiveOrders(tx: Tx, agentId: string): Promise<number> {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(marketOrder)
      .where(
        and(eq(marketOrder.agentId, agentId), inArray(marketOrder.status, ["active", "partial"])),
      );
    return rows[0]?.n ?? 0;
  },

  /**
   * Marca una orden como cancelled (qty_pending se conserva como registro de
   * lo que quedó sin ejecutar; §10.11).
   */
  async markOrderCancelled(tx: Tx, orderId: string): Promise<void> {
    await tx
      .update(marketOrder)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(marketOrder.orderId, orderId));
  },

  // -------------------------------------------------------------------------
  // Procesos del agente (snapshot /agents/me y quiebra)
  // -------------------------------------------------------------------------

  async countRunningProcesses(tx: Tx, agentId: string): Promise<number> {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(transformationProcess)
      .where(
        and(
          eq(transformationProcess.agentId, agentId),
          eq(transformationProcess.status, "running"),
        ),
      );
    return rows[0]?.n ?? 0;
  },

  /**
   * Procesos running del agente + duración (INTERVAL simulado) de su receta,
   * para calcular `current_execution` en lectura (§10.9).
   */
  async listRunningProcessesWithDuration(
    tx: Tx,
    agentId: string,
  ): Promise<RunningProcessWithDuration[]> {
    return tx
      .select({ process: transformationProcess, duration: recipe.duration })
      .from(transformationProcess)
      .innerJoin(recipe, eq(transformationProcess.recipeId, recipe.recipeId))
      .where(
        and(
          eq(transformationProcess.agentId, agentId),
          eq(transformationProcess.status, "running"),
        ),
      )
      .orderBy(asc(transformationProcess.startedAt), asc(transformationProcess.processId));
  },

  // -------------------------------------------------------------------------
  // Eventos recientes (resumen de reconexión, /agents/me)
  // -------------------------------------------------------------------------

  /**
   * Eventos relevantes para el agente, más recientes primero:
   *  - eventos propios (agent_id = agente),
   *  - broadcasts de mercado (agent_registered / agent_bankrupt de cualquiera),
   *  - trades donde participó como comprador o vendedor (vía payload).
   */
  async getRecentEventsForAgent(tx: Tx, agentId: string, limit: number): Promise<EventLogRow[]> {
    if (limit <= 0) return [];
    return tx
      .select()
      .from(eventLog)
      .where(
        or(
          eq(eventLog.agentId, agentId),
          inArray(eventLog.eventType, ["agent_registered", "agent_bankrupt"]),
          and(
            eq(eventLog.eventType, "trade_executed"),
            or(
              sql`${eventLog.payload}->>'buyer_agent_id' = ${agentId}`,
              sql`${eventLog.payload}->>'seller_agent_id' = ${agentId}`,
            ),
          ),
        ),
      )
      .orderBy(desc(eventLog.occurredAt), desc(eventLog.eventId))
      .limit(limit);
  },
};
