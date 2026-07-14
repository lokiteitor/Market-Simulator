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
import {
  BROADCAST_CHANNEL,
  PRODUCT_CHANNEL_PATTERN,
  agentChannel,
  getSubscriberConnection,
  productChannel,
} from "../notifier";
import { logger } from "../observability/logger";
import { wsActiveConnections } from "../observability/metrics";

/** readyState OPEN del protocolo WebSocket (ws no exporta tipos utilizables aquí). */
export const WS_OPEN = 1;

/** Código de cierre "going away" (shutdown del servidor). */
export const CLOSE_GOING_AWAY = 1001;

const AGENT_CHANNEL_PREFIX = agentChannel(""); // "agent:"
const PRODUCT_CHANNEL_PREFIX = productChannel(""); // "product:"

/**
 * Suscripción de tape de un socket: lista de productos concretos o el
 * firehose completo (`"all"`, para la SPA/paneles). Un socket sin suscripción
 * declarada no recibe `trade_printed`.
 */
export type ProductSubscription = readonly string[] | "all";

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
  psubscribe(...patterns: string[]): Promise<unknown>;
  punsubscribe(...patterns: string[]): Promise<unknown>;
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  on(event: "pmessage", listener: (pattern: string, channel: string, message: string) => void): unknown;
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
   * desuscribe `agent:{agentId}` y limpia sus suscripciones de tape.
   * Idempotente.
   */
  removeConnection(agentId: string, socket: HubSocket): Promise<void>;
  /**
   * Declara (reemplaza) la suscripción de tape del socket: los productos cuyo
   * `trade_printed` quiere recibir, o `"all"` (firehose `product:*`).
   * Declarativa e idempotente: cada llamada sustituye a la anterior; el diff
   * contra el estado del hub decide qué canales Redis suscribir/desuscribir
   * (canal `product:{id}` con el primer interesado, fuera con el último).
   * Resuelve cuando el cambio quedó aplicado en Redis.
   */
  setProductSubscriptions(socket: HubSocket, subscription: ProductSubscription): Promise<void>;
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
  // Suscripciones de tape (fan-out selectivo de trade_printed): un socket está
  // en `firehoseSockets` (recibe todo vía pmessage de `product:*`) O en los
  // sets de `socketsByProduct` de sus productos (vía message del canal
  // concreto); nunca en ambos, así no hay entregas duplicadas.
  const socketsByProduct = new Map<string, Set<HubSocket>>();
  const subscriptionBySocket = new Map<HubSocket, Set<string> | "all">();
  const firehoseSockets = new Set<HubSocket>();
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
      return;
    }
    if (channel.startsWith(PRODUCT_CHANNEL_PREFIX)) {
      const productId = channel.slice(PRODUCT_CHANNEL_PREFIX.length);
      const sockets = socketsByProduct.get(productId);
      if (sockets !== undefined) {
        deliver(sockets, message);
      }
    }
  }

  /** Mensajes del patrón `product:*`: SOLO para los sockets firehose. */
  function handlePMessage(_pattern: string, channel: string, message: string): void {
    if (channel.startsWith(PRODUCT_CHANNEL_PREFIX) && firehoseSockets.size > 0) {
      deliver(firehoseSockets, message);
    }
  }

  function ensureSubscriber(): SubscriberLike {
    if (subscriber === null) {
      const sub = createSubscriber();
      sub.on("message", handleMessage);
      sub.on("pmessage", handlePMessage);
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

  /**
   * Aplica la suscripción de tape `next` del socket (null = limpiar) contra la
   * anterior: actualiza los mapas en memoria de forma síncrona y encola el
   * diff de canales Redis (mismo patrón FIFO convergente que los canales de
   * agente: cada op re-verifica el estado del mapa AL EJECUTARSE, y los
   * subscribe/unsubscribe duplicados en Redis son inocuos).
   */
  function applyProductSubscription(
    socket: HubSocket,
    next: Set<string> | "all" | null,
  ): Promise<void> {
    const prev = subscriptionBySocket.get(socket) ?? null;
    const toSubscribe: string[] = [];
    const toUnsubscribe: string[] = [];
    let patternOp: "psubscribe" | "punsubscribe" | null = null;

    // Salida del firehose / de productos concretos que ya no interesan.
    if (prev === "all" && next !== "all") {
      firehoseSockets.delete(socket);
      if (firehoseSockets.size === 0) patternOp = "punsubscribe";
    }
    if (prev instanceof Set) {
      const keep = next instanceof Set ? next : null;
      for (const productId of prev) {
        if (keep !== null && keep.has(productId)) continue;
        const sockets = socketsByProduct.get(productId);
        if (sockets === undefined) continue;
        sockets.delete(socket);
        if (sockets.size === 0) {
          socketsByProduct.delete(productId);
          toUnsubscribe.push(productId);
        }
      }
    }

    // Entrada al firehose / a productos nuevos.
    if (next === "all") {
      if (firehoseSockets.size === 0) patternOp = "psubscribe";
      firehoseSockets.add(socket);
    } else if (next instanceof Set) {
      for (const productId of next) {
        let sockets = socketsByProduct.get(productId);
        if (sockets === undefined) {
          sockets = new Set<HubSocket>();
          socketsByProduct.set(productId, sockets);
          toSubscribe.push(productId);
        }
        sockets.add(socket);
      }
    }

    if (next === null) subscriptionBySocket.delete(socket);
    else subscriptionBySocket.set(socket, next);

    if (toSubscribe.length === 0 && toUnsubscribe.length === 0 && patternOp === null) {
      return Promise.resolve();
    }
    const sub = ensureSubscriber();
    return enqueueRedisOp(async () => {
      const subs = toSubscribe.filter((id) => socketsByProduct.has(id));
      const unsubs = toUnsubscribe.filter((id) => !socketsByProduct.has(id));
      if (subs.length > 0) await sub.subscribe(...subs.map(productChannel));
      if (unsubs.length > 0) await sub.unsubscribe(...unsubs.map(productChannel));
      if (patternOp === "psubscribe" && firehoseSockets.size > 0) {
        await sub.psubscribe(PRODUCT_CHANNEL_PATTERN);
      } else if (patternOp === "punsubscribe" && firehoseSockets.size === 0) {
        await sub.punsubscribe(PRODUCT_CHANNEL_PATTERN);
      }
    });
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
      // La suscripción de tape se limpia SIEMPRE (aunque el socket nunca
      // llegara a registrarse en el mapa de agentes); es no-op si no tenía.
      const cleanupTape = applyProductSubscription(socket, null);
      const sockets = socketsByAgent.get(agentId);
      if (sockets === undefined || !sockets.delete(socket)) {
        await cleanupTape;
        return; // idempotente
      }
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
      await cleanupTape;
    },

    async setProductSubscriptions(
      socket: HubSocket,
      subscription: ProductSubscription,
    ): Promise<void> {
      if (closed) return;
      await applyProductSubscription(
        socket,
        subscription === "all" ? "all" : new Set(subscription),
      );
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
      socketsByProduct.clear();
      subscriptionBySocket.clear();
      firehoseSockets.clear();
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
