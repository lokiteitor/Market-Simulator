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
