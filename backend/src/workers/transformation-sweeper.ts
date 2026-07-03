/**
 * TransformationSweeper (contrato §14, arquitectura §5.3).
 *
 * Job recurrente: materializa procesos de transformación vencidos
 * (`status='running' AND expected_end_at <= now()`) en batches.
 *
 * Toda la lógica de dominio vive en [M4 transformations]:
 * `transformationService.materializeExpiredGlobal(limit)` abre su propia
 * transacción con FOR UPDATE SKIP LOCKED (contrato §8/§10.8), registra
 * `process_completed` en event_log, llama a BankruptcyService y publica las
 * notificaciones `transformation_completed` POST-COMMIT — por eso este
 * sweeper solo invoca y reporta.
 */
import { config } from "../config";
import { logger } from "../observability/logger";
import { transformationService } from "../services/transformation-service";
import type { TransformationMaterializer } from "../types/contracts";

const log = logger.child({ component: "transformation-sweeper" });

// Fijar el tipo de contrato §8: si M4 se desvía de la interfaz, esto no compila.
const materializer: TransformationMaterializer = transformationService;

/**
 * Ejecuta una pasada del sweep. Devuelve el número de procesos materializados
 * (≤ batchSize). El no-solape lo garantiza el worker (concurrency 1 por cola).
 */
export async function runTransformationSweep(
  batchSize: number = config.sweeps.batchSize,
): Promise<number> {
  const materialized = await materializer.materializeExpiredGlobal(batchSize);
  if (materialized > 0) {
    log.info({ materialized, batchSize }, "procesos de transformación materializados");
  } else {
    log.debug({ batchSize }, "sweep de transformaciones sin procesos vencidos");
  }
  return materialized;
}
