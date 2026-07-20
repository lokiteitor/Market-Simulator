/**
 * Repositorio del ledger append-only del ingreso recurrente de las ciudades
 * (flujo circular — gemelo de fee-ledger-repository, ADR-019).
 *
 * El hot path INSERTA aquí sin contención: el pago de salario
 * (transformation-service, `source='wage'`) y el split del fee del matching
 * (order-service, `source='tax'`). El city-income-sweeper del Worker pliega
 * periódicamente lo no materializado y lo reparte entre las ciudades activas.
 *
 * Dinero en tránsito (debitado del pagador, aún no repartido a ciudades) =
 * `sumUnmaterialized`; los lectores de conservación monetaria lo suman.
 */
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../db";
import { incomeLedger } from "../db/schema";

export const incomeLedgerRepository = {
  /** Anota ingreso repartible a las ciudades (INSERT, sin contención). */
  async insertIncome(
    tx: Tx,
    p: {
      amountCents: number;
      source: "wage" | "tax";
      sourceProcessId?: string;
      sourceTradeId?: string;
    },
  ): Promise<void> {
    await tx.insert(incomeLedger).values({
      amountCents: p.amountCents,
      source: p.source,
      sourceProcessId: p.sourceProcessId ?? null,
      sourceTradeId: p.sourceTradeId ?? null,
    });
  },

  /**
   * Σ del ingreso aún no repartido (dinero en tránsito). Lo suma el invariante
   * de conservación (business-metrics / snapshot-runner).
   */
  async sumUnmaterialized(tx: Tx): Promise<number> {
    const rows = await tx
      .select({ total: sql<number>`COALESCE(SUM(${incomeLedger.amountCents}), 0)::bigint` })
      .from(incomeLedger)
      .where(eq(incomeLedger.materialized, false));
    return Number(rows[0]?.total ?? 0);
  },

  /**
   * Σ del ingreso pendiente DESGLOSADO por fuente (`wage` / `tax`), para
   * métricas: muestra qué parte del ciclo alimenta la demanda urbana. Usa el
   * mismo índice parcial `WHERE NOT materialized`, así que es barato aunque la
   * tabla crezca.
   */
  async sumUnmaterializedBySource(tx: Tx): Promise<Array<{ source: string; cents: number }>> {
    const rows = await tx
      .select({
        source: incomeLedger.source,
        cents: sql<number>`COALESCE(SUM(${incomeLedger.amountCents}), 0)::bigint`,
      })
      .from(incomeLedger)
      .where(eq(incomeLedger.materialized, false))
      .groupBy(incomeLedger.source);
    return rows.map((r) => ({ source: r.source, cents: Number(r.cents) }));
  },

  /**
   * Reclama atómicamente un lote de ingreso pendiente: lo marca `materialized`
   * y devuelve la SUMA reclamada. El caller (city-income-service) debe repartir
   * esa suma entre las ciudades en la MISMA tx. Un único escritor de
   * `materialized` (worker concurrency:1) ⇒ sin carreras.
   */
  async materializePending(tx: Tx, limit: number): Promise<number> {
    const result = await tx.execute(sql`
      WITH claimed AS (
        UPDATE income_ledger SET materialized = true
        WHERE income_id IN (
          SELECT income_id FROM income_ledger WHERE NOT materialized
          ORDER BY income_id LIMIT ${limit}
        )
        RETURNING amount_cents
      )
      SELECT COALESCE(SUM(amount_cents), 0)::bigint AS sum FROM claimed
    `);
    const row = (result as unknown as Array<{ sum: string | number }>)[0];
    return Number(row?.sum ?? 0);
  },
};
