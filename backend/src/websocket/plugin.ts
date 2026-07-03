/**
 * Plugin WebSocket (contrato §12, openapi x-websocket-channel) — [M7 websocket]
 *
 * Registra @fastify/websocket y la ruta `GET /ws`; [M10 bootstrap] lo monta
 * bajo `/v1` (`app.register(registerWebsocketRoutes, { prefix: "/v1" })`).
 *
 * Handshake: access token JWT por header `Authorization: Bearer <t>` o por
 * query `?token=` (se acepta también `?access_token=`, el alias que documenta
 * openapi.yaml). DECISIÓN: la verificación se hace TRAS el upgrade y el token
 * inválido/ausente cierra con código 4401 — la vía primaria del contrato §12;
 * así el cliente WS (que no puede leer respuestas HTTP del handshake en
 * browsers) siempre observa un close code distinguible.
 *
 * Canal unidireccional servidor→cliente: los mensajes entrantes del cliente
 * se ignoran (los ping/pong del protocolo los maneja `ws` automáticamente).
 * Heartbeat: ping del servidor cada 30 s; sin pong al siguiente tick ⇒
 * terminate (openapi: "el servidor envía heartbeats periódicos").
 */
import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {} from "@fastify/jwt"; // module augmentation: app.jwt (lo registra el plugin auth [M1])
import { logger } from "../observability/logger";
import { WS_OPEN, wsHub } from "./hub";
import type { HubSocket } from "./hub";

/** Close code de aplicación para handshake no autenticado (contrato §12). */
export const CLOSE_UNAUTHORIZED = 4401;

const HEARTBEAT_INTERVAL_MS = 30_000;

/** Close code 1011 (unexpected condition) para fallos al registrar en el hub. */
const CLOSE_INTERNAL_ERROR = 1011;

/**
 * Superficie del WebSocket de `ws` usada aquí (estructural: `ws` no publica
 * declaraciones de tipos en este árbol de dependencias).
 */
interface WsSocket extends HubSocket {
  on(event: "message", listener: () => void): unknown;
  on(event: "pong", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  ping(): void;
}

/** Extrae el access token del header Authorization o de la query. */
function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string") {
    const [scheme, value] = header.split(" ");
    if (scheme !== undefined && value !== undefined && scheme.toLowerCase() === "bearer" && value.length > 0) {
      return value;
    }
  }
  const query = request.query as Record<string, unknown> | undefined;
  const fromQuery = query?.["token"] ?? query?.["access_token"];
  if (typeof fromQuery === "string" && fromQuery.length > 0) {
    return fromQuery;
  }
  return null;
}

/** Verifica el token con app.jwt y devuelve el agent_id (claim `sub`) o null. */
function verifyAgentId(app: FastifyInstance, request: FastifyRequest): string | null {
  const token = extractToken(request);
  if (token === null) return null;
  try {
    const decoded = app.jwt.verify<{ sub?: unknown }>(token);
    const sub = typeof decoded === "object" && decoded !== null ? decoded.sub : undefined;
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Registra @fastify/websocket, la ruta `GET /ws` y el cierre ordenado del hub.
 * Export esperado por [M10] (contrato §15); aplicar prefijo /v1 al registrarlo.
 */
export async function registerWebsocketRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyWebsocket);

  // Shutdown: cerrar sockets y la conexión Redis suscriptora del hub.
  app.addHook("onClose", async () => {
    await wsHub.close();
  });

  app.get("/ws", { websocket: true }, (rawSocket, request) => {
    const socket = rawSocket as unknown as WsSocket;

    const agentId = verifyAgentId(app, request);
    if (agentId === null) {
      request.log.info("ws: handshake rechazado (token inválido o ausente)");
      socket.close(CLOSE_UNAUTHORIZED, "invalid or missing token");
      return;
    }

    // Canal unidireccional: se ignoran los mensajes entrantes del cliente.
    socket.on("message", () => {
      /* ignorado a propósito (contrato §12) */
    });

    // Heartbeat servidor→cliente.
    let alive = true;
    socket.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WS_OPEN) return;
      if (!alive) {
        request.log.info({ agentId }, "ws: sin pong, terminando conexión");
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch (err) {
        request.log.warn({ err, agentId }, "ws: fallo enviando ping");
      }
    }, HEARTBEAT_INTERVAL_MS);

    socket.on("close", () => {
      clearInterval(heartbeat);
      void wsHub.removeConnection(agentId, socket);
    });
    socket.on("error", (err) => {
      // `ws` emite siempre `close` después de `error`; la limpieza vive allí.
      request.log.warn({ err, agentId }, "ws: error en el socket");
    });

    wsHub.addConnection(agentId, socket).catch((err: unknown) => {
      logger.error({ err, agentId }, "ws: fallo registrando conexión en el hub");
      socket.close(CLOSE_INTERNAL_ERROR, "internal error");
    });

    request.log.info({ agentId }, "ws: conexión establecida");
  });
}
