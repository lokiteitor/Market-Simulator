/**
 * Servicio de agentes [M2 agents] — contrato §§8, 10.12, 10.9.
 *
 * - Implementa `AgentRegistrar` (contratos §8): `createAgent(tx, …)` con
 *   capital semilla dinámico (§10.12) y capacidades del rol leídas de
 *   `infra/seed-config.json` (config.seedConfigPath). Lo consume AuthService
 *   [M1] dentro de SU transacción.
 * - `getSelfState` (GET /agents/me): materializa lazy los procesos vencidos
 *   del agente (TransformationMaterializer [M4]) y arma el snapshot completo
 *   según openapi `AgentSnapshot`.
 * - Lecturas de capacidades / inventario / info pública para el resto de
 *   endpoints `/agents/*`.
 *
 * Nota §10.14: las LECTURAS autenticadas de un agente bankrupt siguen
 * permitidas (el estado bankrupt solo bloquea escrituras de dominio); por eso
 * aquí no se rechaza a agentes en quiebra.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "../config";
import { withTransaction, type Tx } from "../db";
import type { AgentRow, EventLogRow, InventoryLotRow, MarketOrderRow } from "../db/schema";
import { domainError } from "../lib/errors";
import {
  appendEvent,
  type AgentRegisteredPayload,
  type MoneyIssuedPayload,
} from "../lib/event-log";
import { issuanceCapacityCents } from "../lib/gold";
import { intervalToSimSeconds, realMsToSimSeconds } from "../lib/simtime";
import { agentRepository } from "../repositories/agent-repository";
import { bankRepository } from "../repositories/bank-repository";
import type { AgentRegistrar, AgentRole } from "../types/contracts";
import { inventoryService } from "./inventory-service";
import { transformationService } from "./transformation-service";

// ---------------------------------------------------------------------------
// seed-config.json (capacidades por rol, §10.12 / §13)
// ---------------------------------------------------------------------------

const SeedConfigSchema = z.object({
  recipes: z.array(z.object({ key: z.string(), name: z.string() })),
  roles: z.record(
    z.string(),
    z.object({
      capacities: z
        .array(z.object({ recipe: z.string(), installations: z.number().int().positive() }))
        .default([]),
    }),
  ),
});

type SeedConfig = z.infer<typeof SeedConfigSchema>;

let seedConfigCache: SeedConfig | null = null;

/**
 * Carga (y cachea) infra/seed-config.json desde config.seedConfigPath,
 * resuelto relativo al cwd (backend/ en dev; /app en docker).
 */
function loadSeedConfig(): SeedConfig {
  if (seedConfigCache === null) {
    const resolved = path.resolve(process.cwd(), config.seedConfigPath);
    let raw: string;
    try {
      raw = readFileSync(resolved, "utf8");
    } catch (err) {
      throw new Error(
        `No se pudo leer seed-config en "${resolved}" (SEED_CONFIG_PATH=${config.seedConfigPath}): ${String(err)}`,
      );
    }
    seedConfigCache = SeedConfigSchema.parse(JSON.parse(raw));
  }
  return seedConfigCache;
}

// ---------------------------------------------------------------------------
// Vistas de dominio (camelCase; el controller las convierte a snake_case)
// ---------------------------------------------------------------------------

export interface CapacityStatusView {
  recipeId: string;
  installations: number;
  running: number;
  availableSlots: number;
}

export interface InventoryPositionView {
  productId: string;
  qtyAvailable: number;
  qtyReserved: number;
}

/** Proceso running con `current_execution` CALCULADO en lectura (§10.9). */
export interface RunningProcessView {
  processId: string;
  agentId: string;
  recipeId: string;
  executionsPlanned: number;
  currentExecution: number;
  status: "running" | "completed" | "cancelled";
  wagePaidCents: number;
  startedAt: Date;
  expectedEndAt: Date;
  actualEndAt: Date | null;
}

/** Snapshot completo del agente (openapi AgentSnapshot). */
export interface AgentSelfState {
  agent: AgentRow;
  capitalAvailableCents: number;
  capitalReservedCents: number;
  inventory: InventoryPositionView[];
  activeOrders: MarketOrderRow[];
  runningProcesses: RunningProcessView[];
  capacities: CapacityStatusView[];
  recentEvents: EventLogRow[];
}

/**
 * current_execution de un proceso running (§10.9): el avance NO se persiste;
 * se calcula min(executions_planned, floor(elapsedSim / durationSim) + 1).
 * Pura (testeable sin DB).
 */
export function computeCurrentExecution(
  startedAt: Date,
  now: Date,
  durationSimSeconds: number,
  executionsPlanned: number,
): number {
  if (durationSimSeconds <= 0) return executionsPlanned;
  const elapsedSim = realMsToSimSeconds(Math.max(0, now.getTime() - startedAt.getTime()));
  return Math.min(executionsPlanned, Math.floor(elapsedSim / durationSimSeconds) + 1);
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export interface AgentService extends AgentRegistrar {
  /**
   * Snapshot completo para GET /agents/me. ANTES de leer, materializa lazy
   * los procesos vencidos del agente (abre su propia tx, §8).
   */
  getSelfState(agentId: string, eventsLimit?: number): Promise<AgentSelfState>;
  getCapacities(agentId: string): Promise<CapacityStatusView[]>;
  /** Inventario agregado por producto (openapi InventoryPosition). */
  getInventory(agentId: string, productId?: string): Promise<InventoryPositionView[]>;
  /** Detalle por lote, orden FIFO (acquired_at ASC, lot_id ASC). */
  getInventoryLots(
    agentId: string,
    opts?: { productId?: string; onlyWithStock?: boolean },
  ): Promise<InventoryLotRow[]>;
  /** Fila completa del agente; el controller expone solo los campos públicos. */
  getPublicAgent(agentId: string): Promise<AgentRow>;
  /** Fondeo de capital semilla diferido y asíncrono. */
  fundAgentSeedCapital(agentId: string): Promise<void>;
}

export const agentService: AgentService = {
  /**
   * AgentRegistrar.createAgent (§8, §10.12). Corre DENTRO de la tx del caller
   * (AuthService [M1] en registro dinámico; seed [M9] con seedCapitalCents
   * explícito). Capital semilla: floor(promedio del capital TOTAL de agentes
   * activos) o DEFAULT_SEED_CAPITAL_CENTS si no hay ninguno.
   */
  async createAgent(
    tx: Tx,
    p: { username: string; role: AgentRole; seedCapitalCents?: number },
  ): Promise<AgentRow> {
    let seedCapitalCents = p.seedCapitalCents;
    if (seedCapitalCents === undefined) {
      seedCapitalCents = 0;
    }

    const row = await agentRepository.insertAgent(tx, {
      username: p.username,
      role: p.role,
      seedCapitalCents,
    });

    // Capacidades del rol desde seed-config: keys de receta → name → recipe_id.
    const seedConfig = loadSeedConfig();
    const roleCapacities = seedConfig.roles[p.role]?.capacities ?? [];
    if (roleCapacities.length > 0) {
      const nameByKey = new Map(seedConfig.recipes.map((r) => [r.key, r.name]));
      const wanted = roleCapacities.map((c) => {
        const name = nameByKey.get(c.recipe);
        if (name === undefined) {
          throw new Error(
            `seed-config inconsistente: la capacidad del rol ${p.role} referencia la receta "${c.recipe}" que no existe en recipes[]`,
          );
        }
        return { name, installations: c.installations };
      });
      const idsByName = await agentRepository.findRecipeIdsByNames(
        tx,
        wanted.map((w) => w.name),
      );
      const capacities = wanted.map((w) => {
        const recipeId = idsByName.get(w.name);
        if (recipeId === undefined) {
          throw new Error(
            `Catálogo incompleto: la receta "${w.name}" del seed-config no existe en la tabla recipe (¿falta ejecutar el seed?)`,
          );
        }
        return { recipeId, installations: w.installations };
      });
      await agentRepository.insertCapacities(tx, row.agentId, capacities);
    }

    const payload: AgentRegisteredPayload = {
      agent_id: row.agentId,
      username: row.username,
      role: row.role,
      seed_capital_cents: seedCapitalCents,
    };
    await appendEvent(tx, { type: "agent_registered", agentId: row.agentId, payload });

    return row;
  },

  async getSelfState(agentId, eventsLimit = config.reconnectEventsLimit) {
    // Materialización lazy ANTES de leer (abre su propia tx; §8 / openapi).
    await transformationService.materializeExpiredForAgent(agentId);

    return withTransaction(async (tx) => {
      const agentRow = await agentRepository.findById(tx, agentId);
      if (agentRow === undefined) {
        throw domainError("unknown_agent", `El agente ${agentId} no existe.`);
      }

      const inventory = await inventoryService.getPositions(tx, agentId);
      const activeOrders = await agentRepository.listActiveOrders(tx, agentId);
      const processRows = await agentRepository.listRunningProcessesWithDuration(tx, agentId);
      const capacityRows = await agentRepository.getCapacityStatus(tx, agentId);
      const recentEvents = await agentRepository.getRecentEventsForAgent(
        tx,
        agentId,
        eventsLimit,
      );

      const now = new Date();
      const runningProcesses: RunningProcessView[] = processRows.map(({ process, duration }) => ({
        processId: process.processId,
        agentId: process.agentId,
        recipeId: process.recipeId,
        executionsPlanned: process.executionsPlanned,
        currentExecution: computeCurrentExecution(
          process.startedAt,
          now,
          intervalToSimSeconds(duration),
          process.executionsPlanned,
        ),
        status: process.status,
        wagePaidCents: process.wagePaidCents,
        startedAt: process.startedAt,
        expectedEndAt: process.expectedEndAt,
        actualEndAt: process.actualEndAt,
      }));

      return {
        agent: agentRow,
        capitalAvailableCents: agentRow.capitalAvailable,
        capitalReservedCents: agentRow.capitalReserved,
        inventory,
        activeOrders,
        runningProcesses,
        capacities: capacityRows.map((c) => ({
          recipeId: c.recipeId,
          installations: c.installations,
          running: c.running,
          availableSlots: Math.max(0, c.installations - c.running),
        })),
        recentEvents,
      };
    });
  },

  async getCapacities(agentId) {
    return withTransaction(async (tx) => {
      const rows = await agentRepository.getCapacityStatus(tx, agentId);
      return rows.map((c) => ({
        recipeId: c.recipeId,
        installations: c.installations,
        running: c.running,
        availableSlots: Math.max(0, c.installations - c.running),
      }));
    });
  },

  async getInventory(agentId, productId) {
    return withTransaction(async (tx) => {
      const positions = await inventoryService.getPositions(tx, agentId);
      return productId === undefined
        ? positions
        : positions.filter((p) => p.productId === productId);
    });
  },

  async getInventoryLots(agentId, opts) {
    const onlyWithStock = opts?.onlyWithStock ?? true;
    return withTransaction(async (tx) => {
      const lots = await inventoryService.getLots(tx, agentId, opts?.productId);
      const filtered = onlyWithStock
        ? lots.filter((l) => l.qtyAvailable + l.qtyReserved > 0)
        : lots;
      // Orden FIFO defensivo (acquired_at ASC, lot_id ASC) — contrato §8.
      return [...filtered].sort(
        (a, b) =>
          a.acquiredAt.getTime() - b.acquiredAt.getTime() || a.lotId.localeCompare(b.lotId),
      );
    });
  },

  async getPublicAgent(agentId) {
    return withTransaction(async (tx) => {
      const row = await agentRepository.findById(tx, agentId);
      if (row === undefined) {
        throw domainError("unknown_agent", `El agente ${agentId} no existe.`);
      }
      return row;
    });
  },

  async fundAgentSeedCapital(agentId: string): Promise<void> {
    await withTransaction(async (tx) => {
      const gs = await bankRepository.lockGoldStandard(tx);
      const agentRow = await agentRepository.findByIdForUpdate(tx, agentId);
      if (!agentRow || agentRow.seedCapital > 0 || agentRow.status === "bankrupt") {
        return;
      }

      const target =
        (await agentRepository.averageActiveTotalCapitalCents(tx)) ??
        config.defaultSeedCapitalCents;

      let grant = target;
      let emission: { fromBankCents: number; mintedCents: number } | null = null;

      if (gs !== undefined) {
        const bankRow = await bankRepository.findAgent(tx, gs.bankAgentId);
        const bankCapital = bankRow?.capitalAvailable ?? 0;
        const goldAvailable = await bankRepository.getGoldAvailable(
          tx,
          gs.bankAgentId,
          gs.productId,
        );
        const capacity = issuanceCapacityCents(
          goldAvailable,
          gs.parityCentsPerUnit,
          gs.coverageRatioBps,
        );
        const headroom = Math.max(0, capacity - (gs.moneyIssuedCents - gs.moneyBurnedCents));
        grant = Math.min(target, bankCapital + headroom);
        if (grant < config.gold.minRegistrationCapitalCents) {
          throw domainError(
            "insufficient_gold_backing",
            `El banco no puede financiar el capital semilla para ${agentRow.username}: máximo respaldable ${grant} centavos ` +
              `(< mínimo ${config.gold.minRegistrationCapitalCents}).`,
          );
        }
        const fromBankCents = Math.min(grant, bankCapital);
        const mintedCents = grant - fromBankCents;
        if (fromBankCents > 0) {
          const debited = await bankRepository.debitAgentCapital(
            tx,
            gs.bankAgentId,
            fromBankCents,
          );
          if (!debited) {
            throw new Error(
              `fundAgentSeedCapital: débito de ${fromBankCents} al banco falló bajo mutex de emisión`,
            );
          }
        }
        if (mintedCents > 0) {
          await bankRepository.addMoneyIssued(tx, mintedCents);
        }
        emission = { fromBankCents, mintedCents };
      }

      await agentRepository.updateAgentCapitalAndSeed(tx, agentId, grant);

      if (emission !== null) {
        const moneyIssued: MoneyIssuedPayload = {
          agent_id: agentRow.agentId,
          grant_cents: grant,
          from_bank_capital_cents: emission.fromBankCents,
          minted_cents: emission.mintedCents,
        };
        await appendEvent(tx, { type: "money_issued", agentId: agentRow.agentId, payload: moneyIssued });
      }
    });
  },
};

/**
 * Vista `AgentRegistrar` del servicio (contratos §8) — es el mismo singleton;
 * AuthService [M1] la consume para el registro dinámico.
 */
export const agentRegistrar: AgentRegistrar = agentService;
