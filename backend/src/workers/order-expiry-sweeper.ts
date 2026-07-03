/**
 * OrderExpirySweeper (contrato §14, arquitectura §5.3).
 *
 * Job recurrente: marca como `expired` las órdenes activas/parciales con
 * `expires_at <= now()`, libera reservas (capital del comprador / inventario
 * del vendedor) y dispara la verificación de quiebra.
 *
 * Toda la lógica de dominio vive en [M3 orders]:
 * `orderService.expireOverdue(batch)` procesa cada orden en una transacción
 * corta con FOR UPDATE sobre la fila de la orden (SIN el lock in-process de
 * producto — decisión §10.2), registra `order_expired` en event_log y publica
 * las notificaciones `order_expired` POST-COMMIT — por eso este sweeper solo
 * invoca y reporta.
 */
import { config } from "../config";
import { logger } from "../observability/logger";
import { orderService } from "../services/order-service";

const log = logger.child({ component: "order-expiry-sweeper" });

/**
 * Ejecuta una pasada del sweep. Devuelve el número de órdenes expiradas
 * (≤ batchSize). El no-solape lo garantiza el worker (concurrency 1 por cola).
 */
export async function runOrderExpirySweep(
  batchSize: number = config.sweeps.batchSize,
): Promise<number> {
  const expired = await orderService.expireOverdue(batchSize);
  if (expired > 0) {
    log.info({ expired, batchSize }, "órdenes vencidas expiradas");
  } else {
    log.debug({ batchSize }, "sweep de expiración sin órdenes vencidas");
  }
  return expired;
}
