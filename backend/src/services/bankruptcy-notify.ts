/**
 * Notificaciones de quiebra (post-commit, §9/§10).
 *
 * Vive aparte porque hay TRES callers que aplican la quiebra y deben avisar
 * exactamente igual: `order-service` (cancel/expire de orden),
 * `transformation-service` (complete/cancel de proceso) y el endpoint
 * `POST /agents/me/bankruptcy-check` (ADR-026). Publicar es best-effort y
 * SIEMPRE post-commit: un fallo de Redis no puede tumbar la operación ya
 * persistida.
 */
import { publishBroadcast, publishToAgent } from "../notifier";
import { logger } from "../observability/logger";

const log = logger.child({ module: "bankruptcy-notify" });

/** bankruptcy_notice personal + agent_bankrupt broadcast (post-commit, §8). */
export async function publishBankruptcyNotifications(
  agentId: string,
  username: string,
): Promise<void> {
  const occurredAt = new Date().toISOString();
  const payload = { agent_id: agentId, username };
  try {
    await publishToAgent(agentId, {
      type: "bankruptcy_notice",
      occurred_at: occurredAt,
      payload,
    });
  } catch (err) {
    log.warn({ err }, "fallo publicando bankruptcy_notice");
  }
  try {
    await publishBroadcast({ type: "agent_bankrupt", occurred_at: occurredAt, payload });
  } catch (err) {
    log.warn({ err }, "fallo publicando agent_bankrupt broadcast");
  }
}
