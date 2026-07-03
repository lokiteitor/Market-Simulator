/**
 * Configuración central del servicio (contrato §3).
 *
 * Carga TODAS las variables de entorno, las valida con Zod y expone
 * `config` tipado y agrupado. Si algo es inválido, el proceso termina
 * inmediatamente (fail-fast) con un mensaje claro por stderr.
 *
 * Los defaults corresponden a los valores de DESARROLLO de `.env.example`.
 */
import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
const NODE_ENVS = ["development", "test", "production"] as const;

const intFromEnv = (def: number) => z.coerce.number().int().default(def);
const posIntFromEnv = (def: number) => z.coerce.number().int().positive().default(def);
const nonNegIntFromEnv = (def: number) => z.coerce.number().int().nonnegative().default(def);

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1).default("postgres://market:market@localhost:5432/market"),
    REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
    REDIS_PUBSUB_DB: nonNegIntFromEnv(0),
    REDIS_BULLMQ_DB: nonNegIntFromEnv(1),
    PORT: posIntFromEnv(8000),
    METRICS_PORT: posIntFromEnv(8001),
    WORKER_METRICS_PORT: posIntFromEnv(8002),
    JWT_SECRET: z.string().min(1).default("dev-secret-change-me"),
    ACCESS_TOKEN_TTL_SECONDS: posIntFromEnv(900),
    REFRESH_TOKEN_TTL_SECONDS: posIntFromEnv(604800),
    SIM_TIME_FACTOR: z.coerce.number().positive().default(5),
    ORDER_TTL_MIN_SIM_SECONDS: posIntFromEnv(60),
    ORDER_TTL_MAX_SIM_SECONDS: posIntFromEnv(604800),
    FEE_FIXED_CENTS: nonNegIntFromEnv(5),
    FEE_RATE_BPS: nonNegIntFromEnv(25),
    MASTER_SEED: intFromEnv(42),
    DEFAULT_SEED_CAPITAL_CENTS: posIntFromEnv(100000),
    SEED_CAPITAL_PRIMARY_PRODUCER_MIN_CENTS: posIntFromEnv(50000),
    SEED_CAPITAL_PRIMARY_PRODUCER_MAX_CENTS: posIntFromEnv(120000),
    SEED_CAPITAL_TRANSFORMER_MIN_CENTS: posIntFromEnv(120000),
    SEED_CAPITAL_TRANSFORMER_MAX_CENTS: posIntFromEnv(250000),
    SEED_CAPITAL_CONSUMER_MIN_CENTS: posIntFromEnv(80000),
    SEED_CAPITAL_CONSUMER_MAX_CENTS: posIntFromEnv(150000),
    SEED_CAPITAL_TRADER_MIN_CENTS: posIntFromEnv(200000),
    SEED_CAPITAL_TRADER_MAX_CENTS: posIntFromEnv(400000),
    SEED_AGENT_PASSWORD: z.string().min(1).default("dev-password-123"),
    SEED_CONFIG_PATH: z.string().min(1).default("../infra/seed-config.json"),
    TRANSFORMATION_SWEEP_INTERVAL_MS: posIntFromEnv(10000),
    ORDER_EXPIRY_SWEEP_INTERVAL_MS: posIntFromEnv(5000),
    SWEEP_BATCH_SIZE: posIntFromEnv(100),
    IDEMPOTENCY_TTL_SECONDS: posIntFromEnv(600),
    RECONNECT_EVENTS_LIMIT: posIntFromEnv(100),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    NODE_ENV: z.enum(NODE_ENVS).default("development"),
  })
  .refine((e) => e.ORDER_TTL_MIN_SIM_SECONDS <= e.ORDER_TTL_MAX_SIM_SECONDS, {
    message: "ORDER_TTL_MIN_SIM_SECONDS debe ser <= ORDER_TTL_MAX_SIM_SECONDS",
    path: ["ORDER_TTL_MIN_SIM_SECONDS"],
  })
  .refine((e) => e.SEED_CAPITAL_PRIMARY_PRODUCER_MIN_CENTS <= e.SEED_CAPITAL_PRIMARY_PRODUCER_MAX_CENTS, {
    message: "SEED_CAPITAL_PRIMARY_PRODUCER_MIN_CENTS debe ser <= MAX",
    path: ["SEED_CAPITAL_PRIMARY_PRODUCER_MIN_CENTS"],
  })
  .refine((e) => e.SEED_CAPITAL_TRANSFORMER_MIN_CENTS <= e.SEED_CAPITAL_TRANSFORMER_MAX_CENTS, {
    message: "SEED_CAPITAL_TRANSFORMER_MIN_CENTS debe ser <= MAX",
    path: ["SEED_CAPITAL_TRANSFORMER_MIN_CENTS"],
  })
  .refine((e) => e.SEED_CAPITAL_CONSUMER_MIN_CENTS <= e.SEED_CAPITAL_CONSUMER_MAX_CENTS, {
    message: "SEED_CAPITAL_CONSUMER_MIN_CENTS debe ser <= MAX",
    path: ["SEED_CAPITAL_CONSUMER_MIN_CENTS"],
  })
  .refine((e) => e.SEED_CAPITAL_TRADER_MIN_CENTS <= e.SEED_CAPITAL_TRADER_MAX_CENTS, {
    message: "SEED_CAPITAL_TRADER_MIN_CENTS debe ser <= MAX",
    path: ["SEED_CAPITAL_TRADER_MIN_CENTS"],
  });

/** Roles de agente (claves de `seedCapitalRanges`, snake_case como en la DB). */
export type AgentRoleKey = "primary_producer" | "transformer" | "consumer" | "trader";

export interface SeedCapitalRange {
  minCents: number;
  maxCents: number;
}

export interface Config {
  nodeEnv: (typeof NODE_ENVS)[number];
  logLevel: (typeof LOG_LEVELS)[number];
  databaseUrl: string;
  /** URL base de Redis SIN db lógica resuelta. */
  redisUrl: string;
  redisPubSubDb: number;
  redisBullmqDb: number;
  /** URL lista para `new Redis(url)` (pub/sub, DB lógica 0 por defecto). */
  redisPubSubUrl: string;
  /** URL lista para `new Redis(url)` / BullMQ (DB lógica 1 por defecto). */
  redisBullmqUrl: string;
  port: number;
  metricsPort: number;
  workerMetricsPort: number;
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  /** Segundos simulados por segundo real (§4). */
  simTimeFactor: number;
  orderTtl: { minSimSeconds: number; maxSimSeconds: number };
  fees: { fixedCents: number; rateBps: number };
  masterSeed: number;
  defaultSeedCapitalCents: number;
  seedCapitalRanges: Record<AgentRoleKey, SeedCapitalRange>;
  seedAgentPassword: string;
  seedConfigPath: string;
  sweeps: {
    transformationIntervalMs: number;
    orderExpiryIntervalMs: number;
    batchSize: number;
  };
  idempotencyTtlSeconds: number;
  reconnectEventsLimit: number;
}

/** Resuelve la DB lógica de Redis en la URL (`redis://host:port/<db>`), formato que ioredis entiende. */
function redisUrlWithDb(baseUrl: string, db: number): string {
  const u = new URL(baseUrl);
  u.pathname = `/${db}`;
  return u.toString();
}

function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail-fast ANTES de que exista el logger (pino depende de esta config);
    // por eso se usa console.error aquí y solo aquí.
    console.error("[config] Variables de entorno inválidas — abortando arranque:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(env)"}: ${issue.message}`);
    }
    process.exit(1);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    redisPubSubDb: e.REDIS_PUBSUB_DB,
    redisBullmqDb: e.REDIS_BULLMQ_DB,
    redisPubSubUrl: redisUrlWithDb(e.REDIS_URL, e.REDIS_PUBSUB_DB),
    redisBullmqUrl: redisUrlWithDb(e.REDIS_URL, e.REDIS_BULLMQ_DB),
    port: e.PORT,
    metricsPort: e.METRICS_PORT,
    workerMetricsPort: e.WORKER_METRICS_PORT,
    jwtSecret: e.JWT_SECRET,
    accessTokenTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: e.REFRESH_TOKEN_TTL_SECONDS,
    simTimeFactor: e.SIM_TIME_FACTOR,
    orderTtl: {
      minSimSeconds: e.ORDER_TTL_MIN_SIM_SECONDS,
      maxSimSeconds: e.ORDER_TTL_MAX_SIM_SECONDS,
    },
    fees: { fixedCents: e.FEE_FIXED_CENTS, rateBps: e.FEE_RATE_BPS },
    masterSeed: e.MASTER_SEED,
    defaultSeedCapitalCents: e.DEFAULT_SEED_CAPITAL_CENTS,
    seedCapitalRanges: {
      primary_producer: {
        minCents: e.SEED_CAPITAL_PRIMARY_PRODUCER_MIN_CENTS,
        maxCents: e.SEED_CAPITAL_PRIMARY_PRODUCER_MAX_CENTS,
      },
      transformer: {
        minCents: e.SEED_CAPITAL_TRANSFORMER_MIN_CENTS,
        maxCents: e.SEED_CAPITAL_TRANSFORMER_MAX_CENTS,
      },
      consumer: {
        minCents: e.SEED_CAPITAL_CONSUMER_MIN_CENTS,
        maxCents: e.SEED_CAPITAL_CONSUMER_MAX_CENTS,
      },
      trader: {
        minCents: e.SEED_CAPITAL_TRADER_MIN_CENTS,
        maxCents: e.SEED_CAPITAL_TRADER_MAX_CENTS,
      },
    },
    seedAgentPassword: e.SEED_AGENT_PASSWORD,
    seedConfigPath: e.SEED_CONFIG_PATH,
    sweeps: {
      transformationIntervalMs: e.TRANSFORMATION_SWEEP_INTERVAL_MS,
      orderExpiryIntervalMs: e.ORDER_EXPIRY_SWEEP_INTERVAL_MS,
      batchSize: e.SWEEP_BATCH_SIZE,
    },
    idempotencyTtlSeconds: e.IDEMPOTENCY_TTL_SECONDS,
    reconnectEventsLimit: e.RECONNECT_EVENTS_LIMIT,
  };
}

export const config: Config = loadConfig();
