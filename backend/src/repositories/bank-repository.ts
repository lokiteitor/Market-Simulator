/**
 * Repositorio del patrón oro: singleton gold_standard + conversiones — [banco central].
 *
 * Disciplina de locks (anti-deadlock, ver diseño):
 *   - La fila de `gold_standard` (FOR UPDATE) es el elemento MÍNIMO del orden
 *     global: solo la toman la ventanilla de convertibilidad y la emisión de
 *     registro, ANTES de cualquier lock de fila de agente. El matching NUNCA
 *     la toca.
 *   - La fila del agente banco es el elemento MÁXIMO: cualquier tx que la
 *     escriba lo hace como su ÚLTIMA escritura con lock (crédito de fees del
 *     matching, cobro/pago de la ventanilla).
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { Tx } from "../db";
import {
  agent,
  conversionLotConsumption,
  goldConversion,
  goldStandard,
  inventoryLot,
  type AgentRow,
  type GoldConversionRow,
  type GoldStandardRow,
} from "../db/schema";

// Identidad del banco cacheada en memoria: se escribe una vez en el seed y es
// inmutable durante la corrida. `null` = corrida sin patrón oro (DB antigua).
let cachedBankAgentId: string | null | undefined;

export const bankRepository = {
  /** Singleton sin lock (lecturas: GET /bank, snapshots, fees). */
  async getGoldStandard(tx: Tx): Promise<GoldStandardRow | undefined> {
    const rows = await tx.select().from(goldStandard).limit(1);
    return rows[0];
  },

  /**
   * Singleton FOR UPDATE: mutex de la política monetaria (ventanilla y
   * emisión de registro). Tomar SIEMPRE antes de locks de agente.
   */
  async lockGoldStandard(tx: Tx): Promise<GoldStandardRow | undefined> {
    const rows = await tx.select().from(goldStandard).limit(1).for("update");
    return rows[0];
  },

  /**
   * agent_id del banco, cacheado (inmutable post-seed). Devuelve null si la
   * corrida no tiene gold_standard sembrado (los fees se comportan como antes:
   * se evaporan).
   */
  async getBankAgentId(tx: Tx): Promise<string | null> {
    if (cachedBankAgentId === undefined) {
      const row = await bankRepository.getGoldStandard(tx);
      cachedBankAgentId = row?.bankAgentId ?? null;
    }
    return cachedBankAgentId;
  },

  /** Solo para tests: olvida el cache del banco. */
  resetBankAgentIdCache(): void {
    cachedBankAgentId = undefined;
  },

  /**
   * Alta del singleton (solo seed): política monetaria de la corrida, fija
   * salvo los contadores de emisión/destrucción (que arrancan en 0).
   */
  async insertGoldStandard(
    tx: Tx,
    p: {
      bankAgentId: string;
      productId: string;
      parityCentsPerUnit: number;
      windowBidCents: number;
      windowAskCents: number;
      coverageRatioBps: number;
      initialMoneyCents: number;
    },
  ): Promise<void> {
    await tx.insert(goldStandard).values({
      singleton: true,
      ...p,
      moneyIssuedCents: 0,
      moneyBurnedCents: 0,
    });
  },

  /** Suma a money_issued_cents (acuñación: sell_gold, emisión de registro). */
  async addMoneyIssued(tx: Tx, cents: number): Promise<void> {
    if (cents <= 0) return;
    await tx
      .update(goldStandard)
      .set({ moneyIssuedCents: sql`${goldStandard.moneyIssuedCents} + ${cents}` })
      .where(eq(goldStandard.singleton, true));
  },

  /** Suma a money_burned_cents (destrucción: buy_gold). */
  async addMoneyBurned(tx: Tx, cents: number): Promise<void> {
    if (cents <= 0) return;
    await tx
      .update(goldStandard)
      .set({ moneyBurnedCents: sql`${goldStandard.moneyBurnedCents} + ${cents}` })
      .where(eq(goldStandard.singleton, true));
  },

  /** Fila del agente FOR UPDATE (serializa al caller de la ventanilla). */
  async lockAgent(tx: Tx, agentId: string): Promise<AgentRow | undefined> {
    const rows = await tx.select().from(agent).where(eq(agent.agentId, agentId)).for("update");
    return rows[0];
  },

  /** Lectura simple del agente (GET /bank: capital del banco). */
  async findAgent(tx: Tx, agentId: string): Promise<AgentRow | undefined> {
    const rows = await tx.select().from(agent).where(eq(agent.agentId, agentId));
    return rows[0];
  },

  /** Σ qty_available de los lotes del (agente, producto) — oro del banco. */
  async getGoldAvailable(tx: Tx, agentId: string, productId: string): Promise<number> {
    const rows = await tx
      .select({
        total: sql<number>`COALESCE(SUM(${inventoryLot.qtyAvailable}), 0)::bigint`,
      })
      .from(inventoryLot)
      .where(and(eq(inventoryLot.agentId, agentId), eq(inventoryLot.productId, productId)));
    return Number(rows[0]?.total ?? 0);
  },

  /**
   * Débito condicional de capital disponible (§10.3, mismo patrón que
   * deductCapitalAvailable de transformation-repository): false si el agente
   * no cubre el monto (⇒ insufficient_capital en el caller).
   */
  async debitAgentCapital(tx: Tx, agentId: string, cents: number): Promise<boolean> {
    const rows = await tx
      .update(agent)
      .set({ capitalAvailable: sql`${agent.capitalAvailable} - ${cents}` })
      .where(and(eq(agent.agentId, agentId), gte(agent.capitalAvailable, cents)))
      .returning({ agentId: agent.agentId });
    return rows.length > 0;
  },

  async insertConversion(
    tx: Tx,
    p: {
      agentId: string;
      direction: "buy_gold" | "sell_gold";
      productId: string;
      qtyCent: number;
      priceCentsPerUnit: number;
      totalCents: number;
    },
  ): Promise<GoldConversionRow> {
    const rows = await tx.insert(goldConversion).values(p).returning();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("gold_conversion insert returned no rows");
    }
    return row;
  },

  async insertConversionLotConsumptions(
    tx: Tx,
    rows: Array<{
      conversionId: string;
      lotId: string;
      qtyConsumed: number;
      unitCostCents: number;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.insert(conversionLotConsumption).values(rows);
  },
};
