// Notificador Redis pub/sub (CONTRATOS_IMPLEMENTACION.md §9) — [F5 contracts]
//
// Publica notificaciones a canales Redis (DB 0, config.redisPubSubUrl):
//   - `agent:{agentId}`  → notificaciones personales
//   - `broadcast`        → notificaciones globales
//
// El mensaje WS entregado al cliente por el hub [M7] es el JSON `Notification`
// tal cual se publica aquí. Los services publican SOLO post-commit (regla §0).
//
// Payload de `order_executed`: el objeto trade (como en openapi) + `order_id`
// propio + `fill: "partial" | "full"`.

import { Redis } from "ioredis";
import { config } from "../config";

export type NotificationType =
  | "order_executed"
  | "order_expired"
  | "order_cancelled"
  | "transformation_completed"
  | "agent_joined"
  | "agent_bankrupt"
  | "bankruptcy_notice";

export interface Notification {
  type: NotificationType;
  /** ISO 8601. */
  occurred_at: string;
  payload: unknown;
}

/** Canal personal de un agente. */
export function agentChannel(agentId: string): string {
  return `agent:${agentId}`;
}

/** Canal de broadcast global. */
export const BROADCAST_CHANNEL = "broadcast";

// Conexión de publicación: singleton lazy. Una conexión en modo normal puede
// publicar a cualquier canal; se crea en el primer publish y se reutiliza.
let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (publisher === null) {
    publisher = new Redis(config.redisPubSubUrl, {
      // Reintentos automáticos de ioredis; los publish en vuelo se encolan
      // mientras reconecta (comportamiento por defecto de ioredis).
      maxRetriesPerRequest: 3,
    });
  }
  return publisher;
}

/** Publica una notificación personal en el canal `agent:{agentId}`. */
export async function publishToAgent(agentId: string, n: Notification): Promise<void> {
  await getPublisher().publish(agentChannel(agentId), JSON.stringify(n));
}

/** Publica una notificación global en el canal `broadcast`. */
export async function publishBroadcast(n: Notification): Promise<void> {
  await getPublisher().publish(BROADCAST_CHANNEL, JSON.stringify(n));
}

/**
 * Crea una conexión NUEVA dedicada para suscripciones (el WS hub [M7]).
 * Una conexión Redis en modo subscribe no puede ejecutar otros comandos, por
 * eso nunca se comparte con el publisher. El caller es responsable de llamar
 * `.quit()` / `.disconnect()` cuando termine.
 */
export function getSubscriberConnection(): Redis {
  return new Redis(config.redisPubSubUrl, {
    maxRetriesPerRequest: null,
  });
}

/** Cierra la conexión de publicación (graceful shutdown). Idempotente. */
export async function closeNotifier(): Promise<void> {
  if (publisher !== null) {
    const p = publisher;
    publisher = null;
    try {
      await p.quit();
    } catch {
      // Si quit falla (conexión ya caída), forzar el cierre del socket.
      p.disconnect();
    }
  }
}
