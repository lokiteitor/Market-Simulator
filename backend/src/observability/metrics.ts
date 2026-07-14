/**
 * Métricas prom-client compartidas (contrato §14/§15).
 *
 * Un único Registry para el proceso; el server de métricas (Core en
 * METRICS_PORT, worker en WORKER_METRICS_PORT) sirve `register.metrics()`.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const register = new Registry();

collectDefaultMetrics({ register });

/** Duración de requests HTTP; alimentado por hooks onRequest/onResponse [M10]. */
export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duración de las requests HTTP en segundos",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/** Conexiones WebSocket activas; mantenido por el hub WS [M7]. */
export const wsActiveConnections = new Gauge({
  name: "ws_active_connections",
  help: "Conexiones WebSocket activas",
  registers: [register],
});

/** Jobs de BullMQ procesados con éxito, por cola [M8]. */
export const workerJobsProcessed = new Counter({
  name: "worker_jobs_processed_total",
  help: "Jobs del worker procesados con éxito",
  labelNames: ["queue"] as const,
  registers: [register],
});

/** Jobs de BullMQ fallidos, por cola [M8]. */
export const workerJobsFailed = new Counter({
  name: "worker_jobs_failed_total",
  help: "Jobs del worker fallidos",
  labelNames: ["queue"] as const,
  registers: [register],
});

/**
 * Transacciones de Postgres en curso, contadas desde que withTransaction se
 * invoca (incluye la espera por una conexión del pool). Señal de saturación:
 * si vive clavada en db_pool_max con db_transaction_duration_seconds
 * creciendo, las tx están encolando por falta de conexiones.
 */
export const dbTransactionsInFlight = new Gauge({
  name: "db_transactions_in_flight",
  help: "Transacciones withTransaction en curso (incluida la espera de conexión del pool)",
  registers: [register],
});

/** Tamaño configurado del pool (DB_POOL_MAX); referencia para el gauge anterior. */
export const dbPoolMax = new Gauge({
  name: "db_pool_max",
  help: "Conexiones máximas del pool de Postgres configuradas en este proceso",
  registers: [register],
});

/**
 * Duración de withTransaction de la invocación al commit/rollback: incluye la
 * espera de conexión, así el encolamiento del pool se ve como corrimiento de
 * los percentiles aunque las queries sigan siendo rápidas.
 */
export const dbTransactionDuration = new Histogram({
  name: "db_transaction_duration_seconds",
  help: "Duración de withTransaction en segundos (espera de pool incluida)",
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * Requests al cache de lecturas públicas (lib/read-cache), por clase de clave
 * y desenlace (hit | miss | error). El hit-rate por clase es la señal de que
 * el cache está absorbiendo el read-side de los bots.
 */
export const readCacheRequestsTotal = new Counter({
  name: "read_cache_requests_total",
  help: "Consultas al read-cache de Redis por clase de clave y desenlace",
  labelNames: ["key_class", "outcome"] as const,
  registers: [register],
});

// ---------------------------------------------------------------------------
// Métricas de NEGOCIO (event-driven). Se incrementan donde ocurre el evento;
// las series aparecen en el proceso que las emite (matching → core:8001;
// sweeper de transformaciones → worker:8002), ambos ya scrapeados por
// Prometheus. Los agregados de estado (nº agentes, capital, libro) son gauges
// scrape-time en observability/business-metrics.ts (solo en el proceso core).
//
// Convención de labels de producto (compartida con business-metrics.ts):
//   product     → nombre legible ("Trigo"); es el que se agrupa en Grafana.
//   product_id  → UUID, para cruzar con la DB.
// Los contadores resuelven el nombre con observability/product-names.ts.
// ---------------------------------------------------------------------------

/** Trades ejecutados por el matching, por producto [M3]. */
export const tradesExecutedTotal = new Counter({
  name: "trades_executed_total",
  help: "Trades ejecutados por el motor de matching",
  labelNames: ["product", "product_id"] as const,
  registers: [register],
});

/**
 * Volumen negociado (unidades ejecutadas, en centi-unidades como en la DB),
 * por producto [M3]. Alimenta rate() de volumen en Grafana.
 */
export const tradeVolumeUnitsTotal = new Counter({
  name: "trade_volume_units_total",
  help: "Volumen negociado acumulado (qty_executed) por producto",
  labelNames: ["product", "product_id"] as const,
  registers: [register],
});

/**
 * Unidades producidas por transformaciones completadas (qty del lote de
 * producción, centi-unidades), por producto [M8 sweeper].
 */
export const productionUnitsTotal = new Counter({
  name: "production_units_total",
  help: "Unidades producidas por transformaciones, por producto",
  labelNames: ["product", "product_id"] as const,
  registers: [register],
});
