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
// Booleano desde env: "false"/"0"/"no" ⇒ false; cualquier otro string ⇒ true.
const boolFromEnv = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : !["false", "0", "no", ""].includes(v.toLowerCase())));

const EnvSchema = z
  .object({
    DATABASE_URL: z.string().min(1).default("postgres://market:market@localhost:5432/market"),
    // Conexiones máximas del pool de postgres.js POR PROCESO (core y worker
    // tienen cada uno el suyo). Subirlo solo si db_transactions_in_flight
    // vive clavado en este valor con la latencia de tx creciendo; el óptimo
    // ronda 2–4× los cores de Postgres, no el número de bots.
    DB_POOL_MAX: posIntFromEnv(10),
    // Prepared statements de postgres.js. DEBE ser false detrás de PgBouncer en
    // modo transaction (los prepared statements con nombre no sobreviven al
    // reciclado de conexión por transacción). true en dev con Postgres directo.
    DB_PREPARE: boolFromEnv(true),
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
    // Flujo circular: fracción del fee de cada trade desviada del banco a las
    // ciudades (tasa de consumo). Debe ser <= 10000. El SALARIO se recicla
    // SIEMPRE al 100% (no es configurable): un reciclaje parcial dejaría una
    // fracción destruida que obligaría a un SUM de tabla completa en cada
    // lectura del invariante de conservación.
    CITY_FEE_SHARE_BPS: nonNegIntFromEnv(5000),
    MASTER_SEED: intFromEnv(42),
    DEFAULT_SEED_CAPITAL_CENTS: posIntFromEnv(100000),
    SEED_CAPITAL_TRANSFORMER_MIN_CENTS: posIntFromEnv(120000),
    SEED_CAPITAL_TRANSFORMER_MAX_CENTS: posIntFromEnv(250000),
    SEED_CAPITAL_CONSUMER_MIN_CENTS: posIntFromEnv(80000),
    SEED_CAPITAL_CONSUMER_MAX_CENTS: posIntFromEnv(150000),
    SEED_CAPITAL_TRADER_MIN_CENTS: posIntFromEnv(200000),
    SEED_CAPITAL_TRADER_MAX_CENTS: posIntFromEnv(400000),
    SEED_AGENT_PASSWORD: z.string().min(1).default("dev-password-123"),
    SEED_CONFIG_PATH: z.string().min(1).default("../infra/seed-config.json"),
    // Ciudades-consumidor (rol `city`): lista canónica (fuente única compartida
    // con bots-ciudad), contraseña de siembra (DEBE coincidir con la de
    // bots-ciudad/config.yaml) y capital semilla por unidad de population_weight.
    CITY_CONFIG_PATH: z.string().min(1).default("../infra/cities.json"),
    CITY_SEED_PASSWORD: z.string().min(1).default("city-dev-password"),
    CITY_SEED_CAPITAL_CENTS_PER_WEIGHT: posIntFromEnv(50),
    // Patrón oro (§banco central). El banco NO es registrable ni logueable.
    BANK_USERNAME: z.string().min(3).max(64).default("central_bank"),
    GOLD_PRODUCT_KEY: z.string().min(1).default("oro"),
    GOLD_DEPOSIT_MIN_QTY_CENT: posIntFromEnv(80000),
    GOLD_DEPOSIT_MAX_QTY_CENT: posIntFromEnv(150000),
    GOLD_COVERAGE_RATIO_BPS: posIntFromEnv(10000),
    GOLD_WINDOW_SPREAD_BPS: nonNegIntFromEnv(500),
    GOLD_BANK_INITIAL_RESERVE_BPS: nonNegIntFromEnv(2000),
    GOLD_BANK_INITIAL_CAPITAL_CENTS: nonNegIntFromEnv(500000),
    GOLD_MIN_REGISTRATION_CAPITAL_CENTS: posIntFromEnv(10000),
    // Yacimientos finitos genéricos (ADR-023). El tamaño de cada yacimiento se
    // declara en EJECUCIONES de su receta y el seed lo convierte a qty_cent
    // (ejecuciones × output_qty_cent); qué productos son finitos lo marca
    // `finite: true` en infra/seed-config.json. El oro queda FUERA de este
    // rango: su yacimiento lo dimensiona el bloque GOLD_DEPOSIT_* porque la
    // paridad se deriva de él.
    DEPOSIT_MIN_EXECUTIONS: posIntFromEnv(28000),
    DEPOSIT_MAX_EXECUTIONS: posIntFromEnv(52000),
    // Rendimiento decreciente: el rendimiento de una receta con yacimiento cae
    // con la fracción restante (max(floor, remaining/inicial)). El suelo evita
    // que la cola sea infinita; en él el coste unitario se multiplica por
    // 10000/floor (×4 con 2500).
    DEPOSIT_YIELD_FLOOR_BPS: posIntFromEnv(2500),
    // Bootstrap del agente admin (solo-monitoreo). Se crea con
    // `bun src/seed-admin.ts`; NO es registrable por /auth/register.
    ADMIN_USERNAME: z.string().min(3).max(64).default("admin"),
    ADMIN_PASSWORD: z.string().min(12).max(256).default("change-me-admin-please"),
    TRANSFORMATION_SWEEP_INTERVAL_MS: posIntFromEnv(10000),
    ORDER_EXPIRY_SWEEP_INTERVAL_MS: posIntFromEnv(5000),
    // Sweeper que pliega fee_ledger al capital del banco (ADR-019). Frecuente
    // para que el lag del saldo del banco sea pequeño.
    FEE_LEDGER_SWEEP_INTERVAL_MS: posIntFromEnv(5000),
    CITY_INCOME_SWEEP_INTERVAL_MS: posIntFromEnv(5000),
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
  })
  .refine((e) => e.GOLD_DEPOSIT_MIN_QTY_CENT <= e.GOLD_DEPOSIT_MAX_QTY_CENT, {
    message: "GOLD_DEPOSIT_MIN_QTY_CENT debe ser <= MAX",
    path: ["GOLD_DEPOSIT_MIN_QTY_CENT"],
  })
  .refine((e) => e.GOLD_WINDOW_SPREAD_BPS < 10000, {
    message: "GOLD_WINDOW_SPREAD_BPS debe ser < 10000 (el bid quedaría en 0)",
    path: ["GOLD_WINDOW_SPREAD_BPS"],
  })
  .refine((e) => e.GOLD_BANK_INITIAL_RESERVE_BPS <= 10000, {
    message: "GOLD_BANK_INITIAL_RESERVE_BPS debe ser <= 10000 (fracción del yacimiento)",
    path: ["GOLD_BANK_INITIAL_RESERVE_BPS"],
  })
  .refine((e) => e.CITY_FEE_SHARE_BPS <= 10000, {
    message: "CITY_FEE_SHARE_BPS debe ser <= 10000 (fracción del fee)",
    path: ["CITY_FEE_SHARE_BPS"],
  })
  .refine((e) => e.DEPOSIT_MIN_EXECUTIONS <= e.DEPOSIT_MAX_EXECUTIONS, {
    message: "DEPOSIT_MIN_EXECUTIONS debe ser <= MAX",
    path: ["DEPOSIT_MIN_EXECUTIONS"],
  })
  .refine((e) => e.DEPOSIT_YIELD_FLOOR_BPS <= 10000, {
    message: "DEPOSIT_YIELD_FLOOR_BPS debe ser <= 10000 (fracción del rendimiento)",
    path: ["DEPOSIT_YIELD_FLOOR_BPS"],
  });

/** Roles de agente (claves de `seedCapitalRanges`, snake_case como en la DB). */
export type AgentRoleKey = "transformer" | "consumer" | "trader";

export interface SeedCapitalRange {
  minCents: number;
  maxCents: number;
}

export interface Config {
  nodeEnv: (typeof NODE_ENVS)[number];
  logLevel: (typeof LOG_LEVELS)[number];
  databaseUrl: string;
  /** Conexiones máximas del pool de Postgres por proceso. */
  dbPoolMax: number;
  /** Prepared statements de postgres.js (false detrás de PgBouncer transaction). */
  dbPrepare: boolean;
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
  /** Flujo circular: fracción (bps) del fee desviada a las ciudades. */
  cityIncome: { cityFeeShareBps: number };
  masterSeed: number;
  defaultSeedCapitalCents: number;
  seedCapitalRanges: Record<AgentRoleKey, SeedCapitalRange>;
  seedAgentPassword: string;
  seedConfigPath: string;
  /** Siembra de ciudades-consumidor (rol `city`). */
  cities: {
    configPath: string;
    seedPassword: string;
    seedCapitalCentsPerWeight: number;
  };
  /** Parámetros del patrón oro (banco central + yacimiento finito). */
  gold: {
    bankUsername: string;
    productKey: string;
    depositMinQtyCent: number;
    depositMaxQtyCent: number;
    coverageRatioBps: number;
    windowSpreadBps: number;
    bankInitialReserveBps: number;
    bankInitialCapitalCents: number;
    minRegistrationCapitalCents: number;
  };
  /**
   * Yacimientos finitos genéricos (ADR-023): rango del sorteo en EJECUCIONES de
   * la receta y suelo del rendimiento decreciente. No afecta al oro, cuyo
   * yacimiento se dimensiona en `gold`.
   */
  deposits: {
    minExecutions: number;
    maxExecutions: number;
    yieldFloorBps: number;
  };
  /** Credenciales del agente admin (solo-monitoreo); ver src/seed-admin.ts. */
  adminUsername: string;
  adminPassword: string;
  sweeps: {
    transformationIntervalMs: number;
    orderExpiryIntervalMs: number;
    feeLedgerIntervalMs: number;
    cityIncomeIntervalMs: number;
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
    // eslint-disable-next-line no-console
    console.error("[config] Variables de entorno inválidas — abortando arranque:");
    for (const issue of parsed.error.issues) {
      // eslint-disable-next-line no-console
      console.error(`  - ${issue.path.join(".") || "(env)"}: ${issue.message}`);
    }
    process.exit(1);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    dbPrepare: e.DB_PREPARE,
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
    cityIncome: { cityFeeShareBps: e.CITY_FEE_SHARE_BPS },
    masterSeed: e.MASTER_SEED,
    defaultSeedCapitalCents: e.DEFAULT_SEED_CAPITAL_CENTS,
    seedCapitalRanges: {
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
    cities: {
      configPath: e.CITY_CONFIG_PATH,
      seedPassword: e.CITY_SEED_PASSWORD,
      seedCapitalCentsPerWeight: e.CITY_SEED_CAPITAL_CENTS_PER_WEIGHT,
    },
    gold: {
      bankUsername: e.BANK_USERNAME,
      productKey: e.GOLD_PRODUCT_KEY,
      depositMinQtyCent: e.GOLD_DEPOSIT_MIN_QTY_CENT,
      depositMaxQtyCent: e.GOLD_DEPOSIT_MAX_QTY_CENT,
      coverageRatioBps: e.GOLD_COVERAGE_RATIO_BPS,
      windowSpreadBps: e.GOLD_WINDOW_SPREAD_BPS,
      bankInitialReserveBps: e.GOLD_BANK_INITIAL_RESERVE_BPS,
      bankInitialCapitalCents: e.GOLD_BANK_INITIAL_CAPITAL_CENTS,
      minRegistrationCapitalCents: e.GOLD_MIN_REGISTRATION_CAPITAL_CENTS,
    },
    deposits: {
      minExecutions: e.DEPOSIT_MIN_EXECUTIONS,
      maxExecutions: e.DEPOSIT_MAX_EXECUTIONS,
      yieldFloorBps: e.DEPOSIT_YIELD_FLOOR_BPS,
    },
    adminUsername: e.ADMIN_USERNAME,
    adminPassword: e.ADMIN_PASSWORD,
    sweeps: {
      transformationIntervalMs: e.TRANSFORMATION_SWEEP_INTERVAL_MS,
      orderExpiryIntervalMs: e.ORDER_EXPIRY_SWEEP_INTERVAL_MS,
      feeLedgerIntervalMs: e.FEE_LEDGER_SWEEP_INTERVAL_MS,
      cityIncomeIntervalMs: e.CITY_INCOME_SWEEP_INTERVAL_MS,
      batchSize: e.SWEEP_BATCH_SIZE,
    },
    idempotencyTtlSeconds: e.IDEMPOTENCY_TTL_SECONDS,
    reconnectEventsLimit: e.RECONNECT_EVENTS_LIMIT,
  };
}

export const config: Config = loadConfig();
