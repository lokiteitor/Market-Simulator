// Contratos entre módulos (CONTRATOS_IMPLEMENTACION.md §8) — [F5 contracts]
//
// Interfaces TS que los services implementan y consumen entre sí. Los services
// concretos se exportan como objetos singleton, p. ej.:
//   export const inventoryService: InventoryService = { ... };
//
// Tipos de fila derivados de src/db/schema.ts con los helpers de inferencia de
// Drizzle, para que cualquier cambio en el schema se propague automáticamente.

import type { Tx } from "../db";
import type { agent, agentRole, inventoryLot } from "../db/schema";

// ---------------------------------------------------------------------------
// Tipos de fila / enums derivados del schema
// ---------------------------------------------------------------------------

export type AgentRow = typeof agent.$inferSelect;
export type InventoryLotRow = typeof inventoryLot.$inferSelect;
export type AgentRole = (typeof agentRole.enumValues)[number];

// ---------------------------------------------------------------------------
// Inventario (implementa [M5 inventory])
// ---------------------------------------------------------------------------

export interface LotConsumption {
  lotId: string;
  qtyCent: number;
  unitCostCents: number;
}

// FIFO: SIEMPRE ordenado por (acquired_at ASC, lot_id ASC). Reservas, consumos
// y liberaciones operan sobre el pool agregado del agente (no hay mapeo
// orden→lote persistido; decisión documentada en el contrato §8).
export interface InventoryService {
  /** Crea un lote y devuelve su lot_id. */
  createLot(
    tx: Tx,
    p: {
      agentId: string;
      productId: string;
      origin: "initial" | "production" | "purchase";
      qtyCent: number;
      unitCostCents: number;
      sourceTradeId?: string;
      sourceProcessId?: string;
    },
  ): Promise<string>;

  /** Mueve qty de available → reserved en orden FIFO. Lanza insufficient_inventory. */
  reserveFifo(tx: Tx, agentId: string, productId: string, qtyCent: number): Promise<void>;

  /** Devuelve qty de reserved → available en orden FIFO. */
  releaseReservedFifo(tx: Tx, agentId: string, productId: string, qtyCent: number): Promise<void>;

  /** Consume qty del pool reservado en orden FIFO; devuelve el detalle por lote. */
  consumeReservedFifo(
    tx: Tx,
    agentId: string,
    productId: string,
    qtyCent: number,
  ): Promise<LotConsumption[]>;

  /** Consume qty del pool disponible en orden FIFO. Lanza insufficient_inventory. */
  consumeAvailableFifo(
    tx: Tx,
    agentId: string,
    productId: string,
    qtyCent: number,
  ): Promise<LotConsumption[]>;

  /** Posición agregada por producto del agente. */
  getPositions(
    tx: Tx,
    agentId: string,
  ): Promise<Array<{ productId: string; qtyAvailable: number; qtyReserved: number }>>;

  /** Lotes del agente (opcionalmente filtrados por producto). */
  getLots(tx: Tx, agentId: string, productId?: string): Promise<InventoryLotRow[]>;

  /** Σ available+reserved de todos los lotes del agente (para quiebra). */
  getTotalInventory(tx: Tx, agentId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Materialización de transformaciones (implementa [M4 transformations])
// ---------------------------------------------------------------------------

export interface TransformationMaterializer {
  /** Materializa los procesos vencidos del agente. Abre su propia tx; FOR UPDATE. */
  materializeExpiredForAgent(agentId: string): Promise<number>;

  /** Sweep global: FOR UPDATE SKIP LOCKED con LIMIT; devuelve # materializados. */
  materializeExpiredGlobal(limit: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// Quiebra (implementa [M2 agents])
// ---------------------------------------------------------------------------

export interface BankruptcyService {
  /**
   * Llamar DESPUÉS de transiciones terminales (cancel/expire de orden,
   * complete/cancel de proceso), DENTRO de la misma tx.
   *
   * Condición de quiebra (exacta, contrato §8):
   *   capital_available + capital_reserved === 0
   *   Y getTotalInventory === 0
   *   Y sin órdenes en status active/partial
   *   Y sin procesos running.
   *
   * Si detecta quiebra: cancela órdenes residuales, marca bankrupt,
   * appendEvent(agent_bankrupt), y devuelve true. El CALLER publica las
   * notificaciones post-commit (bankruptcy_notice personal + agent_bankrupt
   * broadcast) si devolvió true.
   */
  checkAndApply(tx: Tx, agentId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Registro de agentes (implementa [M2 agents]; lo llama AuthService [M1])
// ---------------------------------------------------------------------------

export interface AgentRegistrar {
  /**
   * Crea agent + capacidades por rol (de seed-config) + capital semilla (§13).
   * Si no se pasa seedCapitalCents: floor(promedio de capital TOTAL de agentes
   * activos), o DEFAULT_SEED_CAPITAL_CENTS si no hay agentes activos (§10.12).
   */
  createAgent(
    tx: Tx,
    p: { username: string; role: AgentRole; seedCapitalCents?: number },
  ): Promise<AgentRow>;
}
