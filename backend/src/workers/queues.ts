/**
 * Nombres de colas BullMQ y opciones de conexión Redis del Worker (contrato §14).
 *
 * Este módulo es la única fuente de verdad para los nombres de cola: los usan
 * el entrypoint del worker (src/worker.ts) y el script de encolado on-demand
 * (src/scripts/enqueue-snapshot.ts). BullMQ opera sobre la DB lógica 1 de
 * Redis (config.redisBullmqUrl).
 *
 * NOTA: se pasan OPCIONES (objeto plano) en vez de una instancia ioredis:
 * bullmq trae su propia copia anidada de ioredis (versión pineada) y una
 * instancia creada con el ioredis top-level no es asignable nominalmente a su
 * `ConnectionOptions`. Con opciones, BullMQ crea y ES DUEÑO de sus conexiones:
 * `queue.close()` / `worker.close()` las cierran (no hay `.quit()` manual).
 */
import { config } from "../config";

// Nombres de cola (contrato §14) — NO cambiar: forman parte de las claves Redis.
export const TRANSFORMATION_SWEEP_QUEUE = "transformation-sweep";
export const ORDER_EXPIRY_SWEEP_QUEUE = "order-expiry-sweep";
export const SNAPSHOT_QUEUE = "snapshot";
export const REFRESH_TOKEN_CLEANUP_QUEUE = "refresh-token-cleanup";
export const GOLD_ISSUANCE_QUEUE = "gold-issuance";

export const WORKER_QUEUES = [
  TRANSFORMATION_SWEEP_QUEUE,
  ORDER_EXPIRY_SWEEP_QUEUE,
  SNAPSHOT_QUEUE,
  REFRESH_TOKEN_CLEANUP_QUEUE,
  GOLD_ISSUANCE_QUEUE,
] as const;

export type WorkerQueueName = (typeof WORKER_QUEUES)[number];

/** Datos del job de la cola `snapshot` (encolado on-demand con nota opcional). */
export interface SnapshotJobData {
  note?: string | null;
}

/**
 * Subconjunto estructural de RedisOptions (ioredis) que BullMQ acepta como
 * `connection`. `maxRetriesPerRequest: null` es REQUERIDO por BullMQ para las
 * conexiones bloqueantes de los Workers.
 */
export interface BullmqRedisOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  maxRetriesPerRequest: null;
}

/**
 * Traduce config.redisBullmqUrl (redis://[user[:pass]@]host[:port]/db) a
 * opciones de conexión para BullMQ (DB lógica 1 resuelta en el path).
 */
export function bullmqConnectionOptions(): BullmqRedisOptions {
  const u = new URL(config.redisBullmqUrl);
  const opts: BullmqRedisOptions = {
    host: u.hostname,
    port: u.port === "" ? 6379 : Number(u.port),
    maxRetriesPerRequest: null,
  };
  const dbPath = u.pathname.replace(/^\//, "");
  if (dbPath !== "") {
    opts.db = Number(dbPath);
  }
  if (u.username !== "") {
    opts.username = decodeURIComponent(u.username);
  }
  if (u.password !== "") {
    opts.password = decodeURIComponent(u.password);
  }
  return opts;
}
