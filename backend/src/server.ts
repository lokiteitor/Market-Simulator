/**
 * Entrypoint del Core (contrato §15) — [M10 bootstrap]
 *
 * - Levanta la app (buildApp) en `config.port`, host 0.0.0.0.
 * - Levanta un server de métricas mínimo (fastify sin logger) en
 *   `config.metricsPort` con `GET /metrics` → `register.metrics()`
 *   (registry compartido de src/observability/metrics).
 * - Graceful shutdown en SIGTERM/SIGINT: cierra la app (hooks onClose cierran
 *   el hub WS y la conexión Redis del healthz), el server de métricas, el pool
 *   de Postgres (closeDb) y el publisher del notifier (closeNotifier).
 *
 * Ejecutar con `bun src/server.ts` (script `start` de package.json).
 */
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { config } from "./config";
import { closeDb } from "./db";
import { closeNotifier } from "./notifier";
import { logger } from "./observability/logger";
import { register } from "./observability/metrics";

/** Server de métricas Prometheus mínimo (sin logger, sin validación Zod). */
function buildMetricsServer(): FastifyInstance {
  const metricsApp = Fastify({ logger: false });
  metricsApp.get("/metrics", async (_request, reply) => {
    const body = await register.metrics();
    return reply.type(register.contentType).send(body);
  });
  return metricsApp;
}

async function main(): Promise<void> {
  const app = buildApp();
  const metricsApp = buildMetricsServer();

  await app.listen({ port: config.port, host: "0.0.0.0" });
  await metricsApp.listen({ port: config.metricsPort, host: "0.0.0.0" });
  logger.info(
    { port: config.port, metricsPort: config.metricsPort },
    "core listo: API y métricas escuchando",
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return; // idempotente ante señales repetidas
    shuttingDown = true;
    logger.info({ signal }, "shutdown iniciado");
    try {
      await app.close();
      await metricsApp.close();
      await closeDb();
      await closeNotifier();
      logger.info("shutdown completo");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error durante el shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "fallo arrancando el core");
  process.exit(1);
});
