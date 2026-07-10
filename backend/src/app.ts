/**
 * Bootstrap de la app Fastify (contrato §15) — [M10 bootstrap]
 *
 * `buildApp()` construye la instancia completa del Core:
 *   - logger pino compartido (src/observability/logger) como `loggerInstance`;
 *   - request-id: header `x-request-id` si viene, si no `crypto.randomUUID()`;
 *   - validación/serialización Zod (fastify-type-provider-zod);
 *   - plugin de auth [M1] (decora `app.authenticate` sin encapsular);
 *   - plugin WebSocket [M7] bajo /v1;
 *   - rutas de M1, M2, M3, M4 y M6 bajo prefijo /v1 (cada módulo exporta
 *     `registerXRoutes(app)` SIN prefijo; el prefijo lo aplica este módulo);
 *   - `GET /healthz` (SELECT 1 en Postgres + PING en Redis ⇒ 200/503);
 *   - hooks de métricas (histograma `http_request_duration_seconds`);
 *   - error handler global RFC 7807 y not-found handler 404 Problem+JSON.
 *
 * El listen() y el server de métricas viven en src/server.ts.
 */
import Fastify from "fastify";
import type {
  FastifyBaseLogger,
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { Redis } from "ioredis";
import { authPlugin } from "./auth/plugin";
import { config } from "./config";
import { sql } from "./db";
import { DomainError, toProblemJson } from "./lib/errors";
import type { ProblemErrorItem, ProblemJson } from "./lib/errors";
import { logger } from "./observability/logger";
import { httpRequestDuration } from "./observability/metrics";
import { registerAdminRoutes } from "./routes/admin";
import { registerAgentRoutes } from "./routes/agents";
import { registerAuthRoutes } from "./routes/auth";
import { registerCatalogRoutes } from "./routes/catalog";
import { registerHistoryRoutes } from "./routes/history";
import { registerMarketRoutes } from "./routes/market";
import { registerOrderRoutes } from "./routes/orders";
import { registerTransformationRoutes } from "./routes/transformations";
import { registerWebsocketRoutes } from "./websocket/plugin";

// Marca de tiempo de inicio de cada request para el histograma de duración.
// Augmentación propia de [M10]; convive (merge de interfaces) con la de
// src/auth/types.d.ts [M1].
declare module "fastify" {
  interface FastifyRequest {
    metricsStartNs: bigint;
  }
}

const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** Timeout defensivo de los chequeos de /healthz (DB y Redis). */
const HEALTHCHECK_TIMEOUT_MS = 2_000;

/** Rechaza si `promise` no resuelve dentro de `ms` (para /healthz). */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout tras ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Envía un ProblemJson con el content-type RFC 7807. */
function sendProblem(reply: FastifyReply, problem: ProblemJson): void {
  void reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

/** `instancePath` de una issue ("/a/b") → campo con puntos ("a.b") o undefined. */
function fieldFromInstancePath(instancePath: string): string | undefined {
  const field = instancePath.replace(/^\//, "").replaceAll("/", ".");
  return field.length > 0 ? field : undefined;
}

/**
 * Handler global de errores (contrato §15):
 *  - DomainError → su status, `toProblemJson` con `instance = request.url`;
 *  - errores de validación Zod/fastify → 400 Problem con `errors[]` por issue;
 *  - error de serialización de respuesta (bug de schema) → 500 logueado;
 *  - otros errores 4xx del framework (JSON malformado, media type, etc.) →
 *    Problem con su status (extensión pragmática documentada: no son errores
 *    internos y devolver 500 sería engañoso);
 *  - resto → 500 logueado con el request id; el Problem NO filtra detalles
 *    internos (solo referencia el request id).
 */
function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof DomainError) {
    sendProblem(reply, toProblemJson(error, request.url));
    return;
  }

  if (hasZodFastifySchemaValidationErrors(error)) {
    const errors: ProblemErrorItem[] = error.validation.map((issue) => {
      const field = fieldFromInstancePath(issue.instancePath);
      return {
        code: issue.keyword,
        ...(field !== undefined ? { field } : {}),
        message: issue.message ?? "Valor inválido",
      };
    });
    sendProblem(reply, {
      type: "https://errors.mercado-agricola/validation-error",
      title: "Solicitud inválida",
      status: 400,
      detail: "La solicitud no supera la validación del schema.",
      instance: request.url,
      errors,
    });
    return;
  }

  // Validación fastify no-Zod (defensivo: aquí todos los compilers son Zod).
  if (error.validation !== undefined && error.validation.length > 0) {
    sendProblem(reply, {
      type: "https://errors.mercado-agricola/validation-error",
      title: "Solicitud inválida",
      status: 400,
      detail: error.message,
      instance: request.url,
      errors: error.validation.map((v) => ({
        code: v.keyword,
        message: v.message ?? "Valor inválido",
      })),
    });
    return;
  }

  if (isResponseSerializationError(error)) {
    // La respuesta construida no cumple su schema: bug del servidor.
    request.log.error({ err: error, reqId: request.id }, "error de serialización de respuesta");
    sendProblem(reply, {
      type: "https://errors.mercado-agricola/internal-error",
      title: "Error interno del servidor",
      status: 500,
      detail: `Error interno inesperado. Referencia: ${String(request.id)}`,
      instance: request.url,
    });
    return;
  }

  if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
    sendProblem(reply, {
      type: "https://errors.mercado-agricola/request-error",
      title: "Error en la solicitud",
      status: error.statusCode,
      detail: error.message,
      instance: request.url,
    });
    return;
  }

  request.log.error({ err: error, reqId: request.id }, "error no manejado");
  sendProblem(reply, {
    type: "https://errors.mercado-agricola/internal-error",
    title: "Error interno del servidor",
    status: 500,
    detail: `Error interno inesperado. Referencia: ${String(request.id)}`,
    instance: request.url,
  });
}

/** Not-found handler: 404 Problem+JSON (contrato §15). */
function notFoundHandler(request: FastifyRequest, reply: FastifyReply): void {
  sendProblem(reply, {
    type: "https://errors.mercado-agricola/not-found",
    title: "Recurso no encontrado",
    status: 404,
    detail: `No existe la ruta ${request.method} ${request.url}.`,
    instance: request.url,
  });
}

/**
 * Construye la app Fastify completa del Core (contrato §15).
 * Los `register` quedan encolados; el boot ocurre en `listen()`/`ready()`.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    // pino.Logger satisface FastifyBaseLogger estructuralmente; el cast fija
    // el genérico Logger de la instancia a FastifyBaseLogger para que el tipo
    // de retorno sea el FastifyInstance canónico del contrato §15.
    loggerInstance: logger as FastifyBaseLogger,
    // Request id: header `x-request-id` del cliente/APISIX si viene; si no,
    // uno propio (uuid v4). El id viaja en los logs (binding reqId).
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  // Zod como único compilador de validación y serialización (ADR-016).
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // ---- Métricas HTTP (contrato §15) --------------------------------------
  // Histograma http_request_duration_seconds{method, route, status}; la ruta
  // usa el patrón registrado (no la URL concreta) para acotar cardinalidad;
  // requests sin ruta (404) se etiquetan "unmatched".
  app.decorateRequest("metricsStartNs", 0n);
  app.addHook("onRequest", async (request) => {
    request.metricsStartNs = process.hrtime.bigint();
  });
  app.addHook("onResponse", async (request, reply) => {
    const seconds = Number(process.hrtime.bigint() - request.metricsStartNs) / 1e9;
    httpRequestDuration.observe(
      {
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        status: String(reply.statusCode),
      },
      seconds,
    );
  });

  // ---- Auth [M1] ----------------------------------------------------------
  // skip-override: decora la instancia raíz (app.authenticate, app.jwt),
  // visible para todos los módulos de rutas registrados después.
  void app.register(authPlugin);

  // ---- WebSocket [M7] ------------------------------------------------------
  void app.register(registerWebsocketRoutes, { prefix: "/v1" });

  // ---- Rutas de dominio bajo /v1 (M1, M2, M3, M4, M6) ---------------------
  // Un único contexto con prefijo /v1; cada módulo registra sus rutas SIN
  // prefijo. `authenticate` llega por la decoración raíz del plugin de auth.
  void app.register(
    async (v1) => {
      registerAuthRoutes(v1);
      await registerAgentRoutes(v1);
      await registerCatalogRoutes(v1);
      await registerMarketRoutes(v1);
      await registerOrderRoutes(v1);
      await registerTransformationRoutes(v1);
      await registerHistoryRoutes(v1);
      registerAdminRoutes(v1);
    },
    { prefix: "/v1" },
  );

  // ---- Healthcheck ---------------------------------------------------------
  // Conexión Redis propia del healthcheck (por instancia de app, cerrada en
  // onClose): sin offline queue para que el PING falle rápido si Redis cayó.
  const healthRedis = new Redis(config.redisPubSubUrl, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  healthRedis.on("error", (err) => {
    // ioredis reintenta solo; se loguea en debug para no inundar los logs
    // durante una caída prolongada (el healthz ya la hace visible).
    logger.debug({ err }, "healthz: error de conexión Redis");
  });
  app.addHook("onClose", async () => {
    try {
      await healthRedis.quit();
    } catch {
      healthRedis.disconnect();
    }
  });

  app.get("/healthz", async (request, reply) => {
    const [dbOk, redisOk] = await Promise.all([
      withTimeout(sql`SELECT 1`, HEALTHCHECK_TIMEOUT_MS).then(
        () => true,
        (err: unknown) => {
          request.log.warn({ err }, "healthz: SELECT 1 falló");
          return false;
        },
      ),
      withTimeout(healthRedis.ping(), HEALTHCHECK_TIMEOUT_MS).then(
        () => true,
        (err: unknown) => {
          request.log.warn({ err }, "healthz: PING Redis falló");
          return false;
        },
      ),
    ]);
    if (dbOk && redisOk) {
      return reply.status(200).send({ status: "ok" });
    }
    return reply.status(503).send({ status: "unavailable" });
  });

  // ---- Errores -------------------------------------------------------------
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  return app;
}
