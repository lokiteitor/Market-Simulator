/**
 * Tests puros del módulo [M8 worker]: nombres de colas y traducción de la
 * URL Redis de BullMQ a opciones de conexión (sin DB, sin Redis).
 */
import { describe, expect, test } from "bun:test";
import {
  CITY_INCOME_SWEEP_QUEUE,
  FEE_LEDGER_SWEEP_QUEUE,
  GOLD_ISSUANCE_QUEUE,
  ORDER_EXPIRY_SWEEP_QUEUE,
  REFRESH_TOKEN_CLEANUP_QUEUE,
  SNAPSHOT_QUEUE,
  TRANSFORMATION_SWEEP_QUEUE,
  WORKER_QUEUES,
  bullmqConnectionOptions,
} from "../../../src/workers/queues";

describe("nombres de colas (contrato §14)", () => {
  test("los nombres son exactamente los del contrato", () => {
    expect(TRANSFORMATION_SWEEP_QUEUE).toBe("transformation-sweep");
    expect(ORDER_EXPIRY_SWEEP_QUEUE).toBe("order-expiry-sweep");
    expect(FEE_LEDGER_SWEEP_QUEUE).toBe("fee-ledger-sweep");
    expect(CITY_INCOME_SWEEP_QUEUE).toBe("city-income-sweep");
    expect(SNAPSHOT_QUEUE).toBe("snapshot");
    expect(REFRESH_TOKEN_CLEANUP_QUEUE).toBe("refresh-token-cleanup");
    expect(GOLD_ISSUANCE_QUEUE).toBe("gold-issuance");
  });

  test("WORKER_QUEUES contiene las 7 colas sin duplicados", () => {
    expect(WORKER_QUEUES).toHaveLength(7);
    expect(new Set(WORKER_QUEUES).size).toBe(7);
  });
});

describe("bullmqConnectionOptions", () => {
  test("resuelve host, puerto y DB lógica desde config.redisBullmqUrl", () => {
    // Con la config por defecto: redis://localhost:6379 + REDIS_BULLMQ_DB=1.
    const opts = bullmqConnectionOptions();
    expect(opts.host).toBe("localhost");
    expect(opts.port).toBe(6379);
    expect(opts.db).toBe(1);
  });

  test("maxRetriesPerRequest es null (requisito de BullMQ para Workers)", () => {
    expect(bullmqConnectionOptions().maxRetriesPerRequest).toBeNull();
  });

  test("sin credenciales en la URL no se emiten username/password", () => {
    const opts = bullmqConnectionOptions();
    expect(opts.username).toBeUndefined();
    expect(opts.password).toBeUndefined();
  });
});
