/**
 * Hub de fanout WebSocket ← Redis pub/sub (contrato §12) — [M7 websocket]
 *
 * DECISIÓN DE DISEÑO: se usa UNA sola conexión Redis suscriptora compartida
 * por proceso, con un mapa `agentId → Set<socket>`, en lugar de una conexión
 * Redis por socket WS: N clientes cuestan 1 conexión Redis (no N), `broadcast`
 * se suscribe una única vez y el canal `agent:{id}` una vez por agente
 * conectado. La "limpieza de suscripción" por socket es: unsubscribe del canal
 * del agente cuando cierra su ÚLTIMO socket; la conexión Redis compartida se
 * cierra (quit) en el shutdown del proceso vía `wsHub.close()` (hook onClose
 * del plugin), no por socket, para evitar churn de conexiones y carreras
 * add/remove.
 *
 * Los mensajes recibidos de Redis se reenvían al socket TAL CUAL (el JSON
 * `Notification` publicado por src/notifier). El hub no parsea ni re-serializa.
 */
import { BROADCAST_CHANNEL, agentChannel, getSubscriberConnection } from "../notifier";
import { logger } from "../observability/logger";
import { wsActiveConnections } from "../observability/metrics";

/** readyState OPEN del protocolo WebSocket (ws no exporta tipos utilizables aquí). */
export const WS_OPEN = 1;

/** Código de cierre "going away" (shutdown del servidor). */
export const CLOSE_GOING_AWAY = 1001;

const AGENT_CHANNEL_PREFIX = agentChannel(""); // "agent:"

/**
 * Superficie mínima que el hub necesita de un socket WS. Estructural a
 * propósito: el WebSocket de `ws` la satisface y los tests unitarios pueden
 * usar fakes puros.
 */
export interface HubSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

/** Superficie mínima de la conexión Redis suscriptora (ioredis la satisface). */
export interface SubscriberLike {
  subscribe(...channels: string[]): Promise<unknown>;
  unsubscribe(...channels: string[]): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  quit(): Promise<unknown>;
}

/** Superficie mínima del gauge de conexiones (prom-client Gauge la satisface). */
export interface ConnectionGauge {
  inc(): void;
  dec(): void;
}

export interface WsHub {
  /**
   * Registra un socket autenticado. El primer socket de un agente dispara la
   * suscripción a `agent:{agentId}`; la primera conexión del proceso crea la
   * conexión Redis compartida y suscribe `broadcast`. Resuelve cuando la
   * suscripción quedó aplicada. Idempotente por (agentId, socket).
   */
  addConnection(agentId: string, socket: HubSocket): Promise<void>;
  /**
   * Da de baja un socket (close/error). Si era el último del agente,
   * desuscribe `agent:{agentId}`. Idempotente.
   */
  removeConnection(agentId: string, socket: HubSocket): Promise<void>;
  /** Total de sockets registrados (== valor del gauge ws_active_connections). */
  activeConnectionCount(): number;
  /** Shutdown: cierra todos los sockets (1001) y hace quit de la conexión Redis. */
  close(): Promise<void>;
}

export interface WsHubDeps {
  /** Fábrica de la conexión suscriptora; default: notifier.getSubscriberConnection. */
  createSubscriber?: () => SubscriberLike;
  /** Gauge de conexiones activas; default: metrics.wsActiveConnections. */
  gauge?: ConnectionGauge;
}

/** Fábrica del hub (inyección de dependencias para tests unitarios puros). */
export function createWsHub(deps: WsHubDeps = {}): WsHub {
  const createSubscriber = deps.createSubscriber ?? getSubscriberConnection;
  const gauge = deps.gauge ?? wsActiveConnections;

  const socketsByAgent = new Map<string, Set<HubSocket>>();
  let subscriber: SubscriberLike | null = null;
  let closed = false;

  // Cadena FIFO que serializa los subscribe/unsubscribe hacia Redis. Cada op
  // re-verifica el estado del mapa AL EJECUTARSE, de modo que secuencias
  // add/remove concurrentes sobre el mismo agente converjan al estado correcto
  // (subscribe duplicado en Redis es inocuo/idempotente).
  let redisOps: Promise<void> = Promise.resolve();
  function enqueueRedisOp(fn: () => Promise<void>): Promise<void> {
    redisOps = redisOps.then(fn).catch((err: unknown) => {
      logger.error({ err }, "ws-hub: fallo en operación de suscripción Redis");
    });
    return redisOps;
  }

  function deliver(sockets: Set<HubSocket>, message: string): void {
    for (const socket of sockets) {
      if (socket.readyState !== WS_OPEN) continue;
      try {
        socket.send(message);
      } catch (err) {
        logger.warn({ err }, "ws-hub: fallo enviando mensaje a socket");
      }
    }
  }

  function handleMessage(channel: string, message: string): void {
    if (channel === BROADCAST_CHANNEL) {
      for (const sockets of socketsByAgent.values()) {
        deliver(sockets, message);
      }
      return;
    }
    if (channel.startsWith(AGENT_CHANNEL_PREFIX)) {
      const agentId = channel.slice(AGENT_CHANNEL_PREFIX.length);
      const sockets = socketsByAgent.get(agentId);
      if (sockets !== undefined) {
        deliver(sockets, message);
      }
    }
  }

  function ensureSubscriber(): SubscriberLike {
    if (subscriber === null) {
      const sub = createSubscriber();
      sub.on("message", handleMessage);
      sub.on("error", (err) => {
        // ioredis reconecta y re-suscribe solo; solo se loguea.
        logger.warn({ err }, "ws-hub: error en la conexión Redis suscriptora");
      });
      subscriber = sub;
      void enqueueRedisOp(async () => {
        await sub.subscribe(BROADCAST_CHANNEL);
      });
    }
    return subscriber;
  }

  return {
    async addConnection(agentId: string, socket: HubSocket): Promise<void> {
      if (closed) {
        socket.close(CLOSE_GOING_AWAY, "server shutting down");
        return;
      }
      const sub = ensureSubscriber();
      let sockets = socketsByAgent.get(agentId);
      const firstForAgent = sockets === undefined;
      if (sockets === undefined) {
        sockets = new Set<HubSocket>();
        socketsByAgent.set(agentId, sockets);
      }
      if (sockets.has(socket)) return;
      sockets.add(socket);
      gauge.inc();
      if (firstForAgent) {
        await enqueueRedisOp(async () => {
          if (socketsByAgent.has(agentId)) {
            await sub.subscribe(agentChannel(agentId));
          }
        });
      }
    },

    async removeConnection(agentId: string, socket: HubSocket): Promise<void> {
      const sockets = socketsByAgent.get(agentId);
      if (sockets === undefined || !sockets.delete(socket)) return; // idempotente
      gauge.dec();
      if (sockets.size === 0) {
        socketsByAgent.delete(agentId);
        const sub = subscriber;
        if (sub !== null) {
          await enqueueRedisOp(async () => {
            if (!socketsByAgent.has(agentId)) {
              await sub.unsubscribe(agentChannel(agentId));
            }
          });
        }
      }
    },

    activeConnectionCount(): number {
      let total = 0;
      for (const sockets of socketsByAgent.values()) total += sockets.size;
      return total;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const sockets of socketsByAgent.values()) {
        for (const socket of sockets) {
          gauge.dec();
          try {
            socket.close(CLOSE_GOING_AWAY, "server shutting down");
          } catch {
            socket.terminate();
          }
        }
      }
      socketsByAgent.clear();
      const sub = subscriber;
      subscriber = null;
      await redisOps; // nunca rechaza: enqueueRedisOp captura errores
      if (sub !== null) {
        try {
          await sub.quit();
        } catch (err) {
          logger.warn({ err }, "ws-hub: fallo cerrando la conexión Redis suscriptora");
        }
      }
    },
  };
}

/** Singleton del proceso Core; el plugin WS [M7] es su único escritor. */
export const wsHub: WsHub = createWsHub();
