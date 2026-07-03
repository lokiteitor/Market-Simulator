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
