/**
 * Cache de lecturas públicas en Redis (cache-aside, best-effort).
 *
 * Motivación: con miles de bots el read-side público (top-of-book, tape,
 * catálogo) es la misma respuesta consultada N veces contra Postgres; este
 * cache convierte ese costo de O(bots) a O(claves/TTL) y deja a Postgres la
 * capacidad para lo que solo él puede hacer (las transacciones del matching).
 *
 * Diseño:
 * - Se cachea el DTO wire (JSON puro del openapi), nunca filas de dominio:
 *   así el round-trip por JSON no pierde tipos (Date) y el hit se sirve sin
 *   re-mapear.
 * - Best-effort: cualquier fallo de Redis degrada a computar contra Postgres
 *   (warn una vez por incidencia, nunca un 5xx por el cache). Los errores del
 *   `compute` (p. ej. unknown_product) se propagan y NO se cachean.
 * - TTLs cortos en vez de invalidación explícita: staleness acotada muy por
 *   debajo de la que los clientes ya toleran (los bots cachean el top 12 s).
 * - Redis de config.redisPubSubUrl (db 0), misma convención que la
 *   idempotencia de order-service: conexión lazy propia del módulo con
 *   reintento acotado (un GET contra un Redis caído rechaza tras un intento
 *   de reconexión y degrada a Postgres, no se encola indefinidamente).
 */
import { Redis } from "ioredis";

import { config } from "../config";
import { readCacheRequestsTotal } from "../observability/metrics";
import { logger } from "../observability/logger";

const log = logger.child({ module: "read-cache" });

let cacheRedis: Redis | null = null;

function getCacheRedis(): Redis {
  if (cacheRedis === null) {
    cacheRedis = new Redis(config.redisPubSubUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    cacheRedis.on("error", (err) => {
      log.warn({ err }, "redis del read-cache: error de conexión");
    });
  }
  return cacheRedis;
}

/**
 * Cache-aside: devuelve el valor cacheado bajo `key` o ejecuta `compute`,
 * cachea su resultado con TTL `ttlMs` y lo devuelve. `keyClass` es el label
 * de la métrica (cardinalidad acotada: "top", "trades", "products", ...).
 *
 * El SET post-miss es fire-and-forget: no añade latencia a la respuesta y su
 * fallo solo significa que el próximo lector vuelve a computar.
 */
export async function cachedJson<T>(
  keyClass: string,
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  try {
    const hit = await getCacheRedis().get(key);
    if (hit !== null) {
      readCacheRequestsTotal.inc({ key_class: keyClass, outcome: "hit" });
      return JSON.parse(hit) as T;
    }
  } catch (err) {
    readCacheRequestsTotal.inc({ key_class: keyClass, outcome: "error" });
    log.warn({ err, key }, "read-cache: GET falló, degradando a Postgres");
    return compute();
  }
  readCacheRequestsTotal.inc({ key_class: keyClass, outcome: "miss" });
  const value = await compute();
  getCacheRedis()
    .set(key, JSON.stringify(value), "PX", ttlMs)
    .catch((err: unknown) => {
      log.warn({ err, key }, "read-cache: SET falló (el valor no queda cacheado)");
    });
  return value;
}

/** Cierra la conexión del cache (graceful shutdown). Idempotente. */
export async function closeReadCache(): Promise<void> {
  if (cacheRedis !== null) {
    const r = cacheRedis;
    cacheRedis = null;
    try {
      await r.quit();
    } catch {
      r.disconnect();
    }
  }
}
