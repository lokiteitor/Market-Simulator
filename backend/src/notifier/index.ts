// Notificador Redis pub/sub (CONTRATOS_IMPLEMENTACION.md §9) — [F5 contracts]
//
// Publica notificaciones a canales Redis (DB 0, config.redisPubSubUrl):
//   - `agent:{agentId}`    → notificaciones personales
//   - `product:{productId}`→ tape por producto (trade_printed); los clientes
//                            se suscriben solo a los productos que operan
//                            (fan-out selectivo) o al patrón `product:*`
//   - `broadcast`          → notificaciones globales (solo eventos raros)
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
  | "agent_bankrupt"
  | "bankruptcy_notice"
  // Tape por producto (canal `product:{id}`) por cada trade ejecutado
  // (payload = objeto Trade del openapi). Los trades ya son públicos vía
  // GET /market/{id}/trades; esto es el tape en tiempo real para clientes
  // event-driven, entregado SOLO a quien se suscribió al producto.
  | "trade_printed"
  // Personal: conversión ejecutada en la ventanilla del banco (patrón oro).
  // Payload = objeto GoldConversion del openapi.
  | "gold_converted"
  // Personal (solo ciudades): ingreso recurrente acreditado por el
  // city-income-sweeper (flujo circular). Payload = { amount_cents }.
  | "city_income";

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

/** Canal del tape de un producto (trade_printed). */
export function productChannel(productId: string): string {
  return `product:${productId}`;
}

/** Patrón pub/sub que cubre el tape de TODOS los productos (firehose). */
export const PRODUCT_CHANNEL_PATTERN = "product:*";

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

/** Publica una notificación del tape en el canal `product:{productId}`. */
export async function publishToProduct(productId: string, n: Notification): Promise<void> {
  await getPublisher().publish(productChannel(productId), JSON.stringify(n));
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
