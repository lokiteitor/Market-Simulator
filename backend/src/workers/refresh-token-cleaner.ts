/**
 * RefreshTokenCleaner (contrato §14, arquitectura §5.3).
 *
 * Job recurrente diario: borra refresh tokens con
 * `expires_at < now() - interval '30 days'`.
 *
 * Los tokens expirados se retienen 30 días antes del borrado físico (ventana
 * de auditoría); un token expirado NUNCA es utilizable aunque siga en la
 * tabla — la validación de /v1/auth/refresh [M1] comprueba expires_at y
 * revoked_at. Un solo DELETE: atómico por sí mismo, sin transacción explícita
 * ni event_log (limpieza técnica, no es una mutación de dominio §9).
 */
import { lt, sql } from "drizzle-orm";
import { db } from "../db";
import { agentRefreshToken } from "../db/schema";
import { logger } from "../observability/logger";

const log = logger.child({ component: "refresh-token-cleaner" });

/** Días de retención de tokens ya expirados antes del borrado físico. */
export const REFRESH_TOKEN_RETENTION_DAYS = 30;

/** Ejecuta la limpieza. Devuelve el número de tokens borrados. */
export async function runRefreshTokenCleanup(): Promise<number> {
  const deleted = await db
    .delete(agentRefreshToken)
    .where(lt(agentRefreshToken.expiresAt, sql`now() - interval '30 days'`))
    .returning({ tokenId: agentRefreshToken.tokenId });

  if (deleted.length > 0) {
    log.info({ deleted: deleted.length }, "refresh tokens expirados eliminados");
  } else {
    log.debug("limpieza de refresh tokens sin filas que borrar");
  }
  return deleted.length;
}
