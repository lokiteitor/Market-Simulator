/**
 * Entrypoint del Worker (contrato §14, arquitectura §5.3).
 *
 * Proceso independiente del Core que reutiliza services y repositories:
 *   - `transformation-sweep`  (repetible cada TRANSFORMATION_SWEEP_INTERVAL_MS)
 *   - `order-expiry-sweep`    (repetible cada ORDER_EXPIRY_SWEEP_INTERVAL_MS)
 *   - `snapshot`              (on-demand; `bun run snapshot [nota]`)
 *   - `refresh-token-cleanup` (repetible diaria)
 *
 * NO-SOLAPE: cada cola tiene UN worker con `concurrency: 1`, y los jobs
 * repetibles de BullMQ mantienen una única instancia programada por scheduler;
 * por lo tanto un sweep nunca corre en paralelo consigo mismo dentro de este
 * proceso. El despliegue (infra/docker-compose.yml) levanta UNA réplica del
 * worker; escalar a varias réplicas exigiría revisar esta garantía.
 *
 * Métricas prom-client (registry compartido de src/observability/metrics.ts)
 * servidas con Bun.serve en WORKER_METRICS_PORT (/metrics), contadores
 * worker_jobs_processed_total / worker_jobs_failed_total por cola.
 */
import { Queue, Worker } from "bullmq";
import type { JobsOptions } from "bullmq";
import { config } from "./config";
import { closeDb } from "./db";
import { closeNotifier } from "./notifier";
import { logger } from "./observability/logger";
import { register, workerJobsFailed, workerJobsProcessed } from "./observability/metrics";
import { runOrderExpirySweep } from "./workers/order-expiry-sweeper";
import { runFeeLedgerSweep } from "./workers/fee-ledger-sweeper";
import {
  ORDER_EXPIRY_SWEEP_QUEUE,
  FEE_LEDGER_SWEEP_QUEUE,
  REFRESH_TOKEN_CLEANUP_QUEUE,
  SNAPSHOT_QUEUE,
  TRANSFORMATION_SWEEP_QUEUE,
  GOLD_ISSUANCE_QUEUE,
  bullmqConnectionOptions,
} from "./workers/queues";
import { agentService } from "./services/agent-service";
import type { SnapshotJobData, WorkerQueueName } from "./workers/queues";
import { runRefreshTokenCleanup } from "./workers/refresh-token-cleaner";
import { runSnapshot } from "./workers/snapshot-runner";
import type { SnapshotResult } from "./workers/snapshot-runner";
import { runTransformationSweep } from "./workers/transformation-sweeper";

const log = logger.child({ component: "worker" });

const DAY_MS = 24 * 60 * 60 * 1000;

// Opciones de conexión Redis (DB lógica 1). BullMQ crea y es dueño de las
// conexiones: se cierran con queue.close() / worker.close() (ver queues.ts).
const connection = bullmqConnectionOptions();

// Retención acotada de jobs terminados para no crecer sin límite en Redis.
const repeatJobOpts: JobsOptions = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
};

// ---------------------------------------------------------------------------
// Colas + schedulers de jobs repetibles (upsert idempotente entre reinicios)
// ---------------------------------------------------------------------------

const transformationQueue = new Queue(TRANSFORMATION_SWEEP_QUEUE, { connection });
const orderExpiryQueue = new Queue(ORDER_EXPIRY_SWEEP_QUEUE, { connection });
const feeLedgerQueue = new Queue(FEE_LEDGER_SWEEP_QUEUE, { connection });
const cleanupQueue = new Queue(REFRESH_TOKEN_CLEANUP_QUEUE, { connection });
const goldIssuanceQueue = new Queue(GOLD_ISSUANCE_QUEUE, { connection });
const queues = [
  transformationQueue,
  orderExpiryQueue,
  feeLedgerQueue,
  cleanupQueue,
  goldIssuanceQueue,
];

await transformationQueue.upsertJobScheduler(
  "transformation-sweep-every",
  { every: config.sweeps.transformationIntervalMs },
  { name: "transformation-sweep", opts: repeatJobOpts },
);
await orderExpiryQueue.upsertJobScheduler(
  "order-expiry-sweep-every",
  { every: config.sweeps.orderExpiryIntervalMs },
  { name: "order-expiry-sweep", opts: repeatJobOpts },
);
await feeLedgerQueue.upsertJobScheduler(
  "fee-ledger-sweep-every",
  { every: config.sweeps.feeLedgerIntervalMs },
  { name: "fee-ledger-sweep", opts: repeatJobOpts },
);
await cleanupQueue.upsertJobScheduler(
  "refresh-token-cleanup-daily",
  { every: DAY_MS },
  { name: "refresh-token-cleanup", opts: repeatJobOpts },
);

// ---------------------------------------------------------------------------
// Workers (concurrency 1 por cola ⇒ un sweep nunca se solapa consigo mismo)
// ---------------------------------------------------------------------------

function instrument<D, R, N extends string>(
  w: Worker<D, R, N>,
  queueName: WorkerQueueName,
): Worker<D, R, N> {
  w.on("completed", (job, returnValue) => {
    workerJobsProcessed.inc({ queue: queueName });
    log.debug({ queue: queueName, jobId: job.id, returnValue }, "job completado");
  });
  w.on("failed", (job, err) => {
    workerJobsFailed.inc({ queue: queueName });
    log.error({ queue: queueName, jobId: job?.id, err }, "job fallido");
  });
  w.on("error", (err) => {
    log.error({ queue: queueName, err }, "error del worker BullMQ");
  });
  return w;
}

const transformationWorker = instrument(
  new Worker(
    TRANSFORMATION_SWEEP_QUEUE,
    async () => runTransformationSweep(config.sweeps.batchSize),
    { connection, concurrency: 1 },
  ),
  TRANSFORMATION_SWEEP_QUEUE,
);

const orderExpiryWorker = instrument(
  new Worker(
    ORDER_EXPIRY_SWEEP_QUEUE,
    async () => runOrderExpirySweep(config.sweeps.batchSize),
    { connection, concurrency: 1 },
  ),
  ORDER_EXPIRY_SWEEP_QUEUE,
);

const feeLedgerWorker = instrument(
  new Worker(FEE_LEDGER_SWEEP_QUEUE, async () => runFeeLedgerSweep(config.sweeps.batchSize), {
    connection,
    concurrency: 1,
  }),
  FEE_LEDGER_SWEEP_QUEUE,
);

const snapshotWorker = instrument(
  new Worker<SnapshotJobData, SnapshotResult>(
    SNAPSHOT_QUEUE,
    async (job) => runSnapshot(job.data?.note ?? null),
    { connection, concurrency: 1 },
  ),
  SNAPSHOT_QUEUE,
);

const cleanupWorker = instrument(
  new Worker(REFRESH_TOKEN_CLEANUP_QUEUE, async () => runRefreshTokenCleanup(), {
    connection,
    concurrency: 1,
  }),
  REFRESH_TOKEN_CLEANUP_QUEUE,
);

const goldIssuanceWorker = instrument(
  new Worker<{ agentId: string }>(
    GOLD_ISSUANCE_QUEUE,
    async (job) => {
      await agentService.fundAgentSeedCapital(job.data.agentId);
    },
    { connection, concurrency: 1 },
  ),
  GOLD_ISSUANCE_QUEUE,
);

const workers = [
  transformationWorker,
  orderExpiryWorker,
  feeLedgerWorker,
  snapshotWorker,
  cleanupWorker,
  goldIssuanceWorker,
];

// ---------------------------------------------------------------------------
// Servidor de métricas (registry compartido) en WORKER_METRICS_PORT
// ---------------------------------------------------------------------------

const metricsServer = Bun.serve({
  port: config.workerMetricsPort,
  fetch: async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (path === "/metrics") {
      return new Response(await register.metrics(), {
        headers: { "content-type": register.contentType },
      });
    }
    if (path === "/healthz") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

log.info(
  {
    queues: {
      [TRANSFORMATION_SWEEP_QUEUE]: `${config.sweeps.transformationIntervalMs}ms`,
      [ORDER_EXPIRY_SWEEP_QUEUE]: `${config.sweeps.orderExpiryIntervalMs}ms`,
      [FEE_LEDGER_SWEEP_QUEUE]: `${config.sweeps.feeLedgerIntervalMs}ms`,
      [SNAPSHOT_QUEUE]: "on-demand",
      [REFRESH_TOKEN_CLEANUP_QUEUE]: `${DAY_MS}ms`,
    },
    batchSize: config.sweeps.batchSize,
    metricsPort: config.workerMetricsPort,
  },
  "worker iniciado",
);

// ---------------------------------------------------------------------------
// Graceful shutdown: workers → colas → notifier → db → redis
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "worker: iniciando graceful shutdown");

  // Deja de aceptar scrapes; los jobs activos terminan antes de cerrar.
  metricsServer.stop(true);
  // worker.close()/queue.close() cierran también sus conexiones Redis propias.
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled(queues.map((q) => q.close()));
  await closeNotifier();
  await closeDb();

  log.info("worker: shutdown completo");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => {
  log.error({ err }, "unhandledRejection en el worker");
});
