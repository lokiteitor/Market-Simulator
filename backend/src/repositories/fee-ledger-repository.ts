/**
 * Repositorio del ledger append-only de fees del matching (ADR-019) — [banco central].
 *
 * El hot path del matching INSERTA aquí un registro por orden que genera fees,
 * en vez de hacer UPDATE de la fila caliente del agente banco (que serializaría
 * todos los trades de todas las réplicas del Core). El sweeper del Worker pliega
 * periódicamente los registros no materializados al capital del banco.
 *
 * Saldo real del banco = agent.capital_available + `sumUnmaterialized`.
 */
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../db";
import { feeLedger } from "../db/schema";

export const feeLedgerRepository = {
  /** Anota un fee acreditable al banco (INSERT, sin contención entre trades). */
  async insertFee(tx: Tx, p: { tradeId: string; amountCents: number }): Promise<void> {
    await tx.insert(feeLedger).values({ tradeId: p.tradeId, amountCents: p.amountCents });
  },

  /**
   * Σ de fees aún no materializados (lo que falta por plegar a la fila del
   * banco). Lo suman los LECTORES del saldo del banco (GET /bank, métricas,
   * snapshots) y el invariante de conservación.
   */
  async sumUnmaterialized(tx: Tx): Promise<number> {
    const rows = await tx
      .select({ total: sql<number>`COALESCE(SUM(${feeLedger.amountCents}), 0)::bigint` })
      .from(feeLedger)
      .where(eq(feeLedger.materialized, false));
    return Number(rows[0]?.total ?? 0);
  },

  /**
   * Reclama atómicamente un lote de fees pendientes: los marca `materialized` y
   * devuelve la SUMA reclamada. El caller (sweeper / financiación de semilla)
   * debe acreditar esa suma a la fila del banco en la MISMA tx. Un único
   * escritor de `materialized` (worker concurrency:1) ⇒ sin carreras; el LIMIT
   * acota el batch y los inserts posteriores se plegarán en el siguiente sweep.
   */
  async materializePending(tx: Tx, limit: number): Promise<number> {
    const result = await tx.execute(sql`
      WITH claimed AS (
        UPDATE fee_ledger SET materialized = true
        WHERE fee_id IN (
          SELECT fee_id FROM fee_ledger WHERE NOT materialized
          ORDER BY fee_id LIMIT ${limit}
        )
        RETURNING amount_cents
      )
      SELECT COALESCE(SUM(amount_cents), 0)::bigint AS sum FROM claimed
    `);
    const row = (result as unknown as Array<{ sum: string | number }>)[0];
    return Number(row?.sum ?? 0);
  },
};
