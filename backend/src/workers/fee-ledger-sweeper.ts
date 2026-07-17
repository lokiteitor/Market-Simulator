/**
 * FeeLedgerSweeper (ADR-019, contrato §14).
 *
 * Job recurrente: pliega los fees no materializados de `fee_ledger` al capital
 * del banco central. Sustituye al UPDATE por-trade de la fila caliente del
 * banco (que serializaría todos los trades entre las N réplicas del Core): el
 * hot path del matching solo INSERTA en el ledger; este sweeper acumula y
 * acredita en batch.
 *
 * La lógica de dominio vive en `bankService.materializeFees` (una tx bajo
 * `lockGoldStandard`, respetando el orden global de locks). El no-solape lo
 * garantiza el worker (concurrency 1 por cola). Idempotente: reclama por lotes.
 */
import { config } from "../config";
import { withTransaction } from "../db";
import { logger } from "../observability/logger";
import { bankService } from "../services/bank-service";

const log = logger.child({ component: "fee-ledger-sweeper" });

/**
 * Ejecuta una pasada del sweep. Devuelve los centavos de fees acreditados al
 * banco (≤ los pendientes hasta batchSize).
 */
export async function runFeeLedgerSweep(
  batchSize: number = config.sweeps.batchSize,
): Promise<number> {
  const creditedCents = await withTransaction((tx) => bankService.materializeFees(tx, batchSize));
  if (creditedCents > 0) {
    log.info({ creditedCents, batchSize }, "fees plegados al capital del banco");
  } else {
    log.debug({ batchSize }, "sweep de fees sin pendientes");
  }
  return creditedCents;
}
