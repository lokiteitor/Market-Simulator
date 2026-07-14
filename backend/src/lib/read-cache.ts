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
 * - Single-flight (anti-estampida): los misses concurrentes de la MISMA clave
 *   comparten un único compute en vez de encolar queries duplicadas en
 *   Postgres. Sin esto, bajo saturación del pool el compute tarda más que el
 *   TTL y cada expiración dispara una estampida de duplicados (visto en vivo:
 *   ~180 misses/s de top = 60% de las tx de PG con el pool colapsado).
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
 * Computes en vuelo por clave (single-flight). La entrada se borra cuando el
 * compute termina (éxito o error): un error se propaga a todos los que lo
 * compartieron y el siguiente request recomputa desde cero.
 */
const inflightComputes = new Map<string, Promise<unknown>>();

/**
 * Ejecuta `compute` con single-flight por clave: si ya hay uno en vuelo para
 * `key`, se comparte su resultado en vez de duplicar la query. Si
 * `cacheResult` es true, el resultado se cachea (SET fire-and-forget: no
 * añade latencia y su fallo solo significa que el próximo lector recomputa).
 */
function computeSingleFlight<T>(
  keyClass: string,
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
  cacheResult: boolean,
): Promise<T> {
  const existing = inflightComputes.get(key);
  if (existing !== undefined) {
    readCacheRequestsTotal.inc({ key_class: keyClass, outcome: "coalesced" });
    return existing as Promise<T>;
  }
  readCacheRequestsTotal.inc({ key_class: keyClass, outcome: "miss" });
  const p = (async () => {
    const value = await compute();
    if (cacheResult) {
      getCacheRedis()
        .set(key, JSON.stringify(value), "PX", ttlMs)
        .catch((err: unknown) => {
          log.warn({ err, key }, "read-cache: SET falló (el valor no queda cacheado)");
        });
    }
    return value;
  })();
  inflightComputes.set(key, p);
  // Limpieza tras asentarse, con el rechazo observado para no generar
  // unhandledRejection (los callers sí observan el rechazo de `p`).
  void p.then(
    () => undefined,
    () => undefined,
  ).then(() => {
    inflightComputes.delete(key);
  });
  return p;
}

/**
 * Cache-aside: devuelve el valor cacheado bajo `key` o ejecuta `compute`
 * (single-flight), cachea su resultado con TTL `ttlMs` y lo devuelve.
 * `keyClass` es el label de la métrica (cardinalidad acotada: "top",
 * "trades", "products", ...).
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
    // Con Redis caído el single-flight sigue protegiendo a Postgres de la
    // estampida; no se intenta el SET (fallaría con ruido).
    return computeSingleFlight(keyClass, key, ttlMs, compute, false);
  }
  return computeSingleFlight(keyClass, key, ttlMs, compute, true);
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
