/**
 * Servicio de órdenes (§§4-diseño, 5, 10.1-10.7, 10.11, 10.14) — [M3 orders].
 *
 * Abre las transacciones (withTransaction) y el lock por producto
 * (withProductLock) que serializa el matching (§10.2). Toda mutación:
 * tx atómica + appendEvent en la misma tx + notificaciones SOLO post-commit.
 */
import { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { withTransaction, type Tx } from "../db";
import { agent, product, type MarketOrderRow, type TradeRow } from "../db/schema";
import { decodeCursor } from "../lib/cursor";
import { domainError } from "../lib/errors";
import {
  appendEvent,
  type OrderCancelledPayload,
  type OrderExpiredPayload,
  type OrderPlacedPayload,
} from "../lib/event-log";
import { withProductLock } from "../lib/locks";
import { notionalCents, reserveForQty } from "../lib/money";
import { expiresAtFromTtl } from "../lib/simtime";
import { publishBroadcast, publishToAgent, type Notification } from "../notifier";
import { logger } from "../observability/logger";
import {
  orderRepository,
  isOpenStatus,
  OPEN_ORDER_STATUSES,
  type OrderSide,
  type OrderStatus,
} from "../repositories/order-repository";
import { tradeRepository } from "../repositories/trade-repository";
import { buildPage } from "../schemas/common";
import { tradeToApi } from "../schemas/orders";
import type { InventoryService, BankruptcyService } from "../types/contracts";
// Módulos paralelos ([M5], [M2]); nombres exactos del contrato §8.
import { inventoryService } from "./inventory-service";
import { bankruptcyService } from "./bankruptcy-service";
import { matchOrder, type ExecutedTrade } from "./matching/engine";
import { releaseReservedCapital, reserveBuyerCapital } from "./matching/capital";

const log = logger.child({ module: "order-service" });

// Tipado explícito contra los contratos §8 (los singletons los implementan).
const inventory: InventoryService = inventoryService;
const bankruptcy: BankruptcyService = bankruptcyService;

// ---------------------------------------------------------------------------
// Idempotencia (§10.7): conexión ioredis lazy propia a config.redisPubSubUrl.
// Clave `idem:{agentId}:{clientOrderId}` → order_id, TTL IDEMPOTENCY_TTL_SECONDS.
// ---------------------------------------------------------------------------

let idemRedis: Redis | null = null;

function getIdemRedis(): Redis {
  if (idemRedis === null) {
    idemRedis = new Redis(config.redisPubSubUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
    idemRedis.on("error", (err) => {
      log.warn({ err }, "redis de idempotencia: error de conexión");
    });
  }
  return idemRedis;
}

function idemKey(agentId: string, clientOrderId: string): string {
  return `idem:${agentId}:${clientOrderId}`;
}

/** Cierre ordenado de la conexión de idempotencia (shutdown/tests). Idempotente. */
export async function closeOrderIdempotency(): Promise<void> {
  if (idemRedis !== null) {
    const r = idemRedis;
    idemRedis = null;
    try {
      await r.quit();
    } catch {
      r.disconnect();
    }
  }
}

// ---------------------------------------------------------------------------
// Tipos públicos del service
// ---------------------------------------------------------------------------

export interface PlaceOrderInput {
  productId: string;
  side: OrderSide;
  qtyCent: number;
  limitPriceCents: number;
  /** Segundos SIMULADOS (§4). */
  ttlSeconds: number;
  clientOrderId?: string | undefined;
}

export interface PlaceOrderResult {
  order: MarketOrderRow;
  /** Trades del primer ciclo de matching (vacío en replay idempotente). */
  trades: TradeRow[];
  /** true ⇒ reenvío con el mismo client_order_id dentro de la ventana (⇒ 200). */
  replayed: boolean;
}

export interface CancelOrderResult {
  order: MarketOrderRow;
  /** true ⇒ ya estaba terminal; no se modificó (⇒ 200 idempotente, §10.11). */
  alreadyTerminal: boolean;
}

export interface ListOrdersParams {
  statuses?: OrderStatus[] | undefined;
  productId?: string | undefined;
  side?: OrderSide | undefined;
  since?: Date | undefined;
  cursor?: string | undefined;
  limit: number;
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

interface AgentSummary {
  agentId: string;
  username: string;
  status: "active" | "bankrupt";
}

async function getAgentSummary(tx: Tx, agentId: string): Promise<AgentSummary> {
  const rows = await tx
    .select({ agentId: agent.agentId, username: agent.username, status: agent.status })
    .from(agent)
    .where(eq(agent.agentId, agentId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw domainError("unknown_agent", "El agente autenticado no existe.");
  }
  return row;
}

function assertNotBankrupt(a: AgentSummary): void {
  // §10.14: TODAS las escrituras de dominio de un agente bankrupt ⇒ 403.
  if (a.status === "bankrupt") {
    throw domainError("agent_bankrupt", "El agente está en quiebra y no puede operar.");
  }
}

async function assertProductExists(tx: Tx, productId: string): Promise<void> {
  const rows = await tx
    .select({ productId: product.productId })
    .from(product)
    .where(eq(product.productId, productId))
    .limit(1);
  if (rows[0] === undefined) {
    throw domainError("unknown_product", `El producto ${productId} no existe.`, {
      field: "product_id",
    });
  }
}

/** Publica sin propagar errores: las notificaciones son post-commit y best-effort. */
async function safePublish(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn({ err, what }, "fallo publicando notificación post-commit");
  }
}

/**
 * order_executed a AMBAS contrapartes por cada trade (§9): payload = objeto
 * Trade del openapi + `order_id` propio + `fill: "partial"|"full"`.
 */
async function publishTradeNotifications(executed: ExecutedTrade[]): Promise<void> {
  for (const e of executed) {
    const occurredAt = e.trade.executedAt.toISOString();
    const base = tradeToApi(e.trade);
    const toBuyer: Notification = {
      type: "order_executed",
      occurred_at: occurredAt,
      payload: { ...base, order_id: e.trade.buyOrderId, fill: e.buyerFill },
    };
    const toSeller: Notification = {
      type: "order_executed",
      occurred_at: occurredAt,
      payload: { ...base, order_id: e.trade.sellOrderId, fill: e.sellerFill },
    };
    await safePublish("order_executed→buyer", () =>
      publishToAgent(e.trade.buyerAgentId, toBuyer),
    );
    await safePublish("order_executed→seller", () =>
      publishToAgent(e.trade.sellerAgentId, toSeller),
    );
  }
}

/** bankruptcy_notice personal + agent_bankrupt broadcast (post-commit, §8). */
async function publishBankruptcyNotifications(agentId: string, username: string): Promise<void> {
  const occurredAt = new Date().toISOString();
  const payload = { agent_id: agentId, username };
  await safePublish("bankruptcy_notice", () =>
    publishToAgent(agentId, { type: "bankruptcy_notice", occurred_at: occurredAt, payload }),
  );
  await safePublish("agent_bankrupt broadcast", () =>
    publishBroadcast({ type: "agent_bankrupt", occurred_at: occurredAt, payload }),
  );
}

/** Libera las reservas residuales de una orden viva (cancelación/expiración §5). */
async function releaseOrderReserves(tx: Tx, order: MarketOrderRow): Promise<void> {
  if (order.side === "buy") {
    await releaseReservedCapital(
      tx,
      order.agentId,
      notionalCents(order.qtyPending, order.limitPriceCents),
    );
  } else {
    await inventory.releaseReservedFifo(tx, order.agentId, order.productId, order.qtyPending);
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const orderService = {
  /**
   * Coloca una orden (§4 del diseño + §10.1-10.5, §10.7):
   * validaciones → reserva → INSERT → order_placed → matching → post-commit
   * (idem SET + notificaciones order_executed).
   */
  async placeOrder(agentId: string, input: PlaceOrderInput): Promise<PlaceOrderResult> {
    // Idempotencia (§10.7): GET ANTES de crear; hit ⇒ 200 con la orden releída,
    // sin re-matching. Best-effort: si Redis falla, se loguea y se continúa.
    if (input.clientOrderId !== undefined) {
      let existingOrderId: string | null = null;
      try {
        existingOrderId = await getIdemRedis().get(idemKey(agentId, input.clientOrderId));
      } catch (err) {
        log.warn({ err }, "idempotencia: GET falló; se continúa colocando la orden");
      }
      if (existingOrderId !== null) {
        const existing = await withTransaction((tx) => orderRepository.getById(tx, existingOrderId));
        if (existing !== undefined && existing.agentId === agentId) {
          return { order: existing, trades: [], replayed: true };
        }
      }
    }

    // TTL (§10.5) ⇒ 422 ttl_out_of_range.
    const { minSimSeconds, maxSimSeconds } = config.orderTtl;
    if (input.ttlSeconds < minSimSeconds || input.ttlSeconds > maxSimSeconds) {
      throw domainError(
        "ttl_out_of_range",
        `ttl_seconds debe estar entre ${minSimSeconds} y ${maxSimSeconds} segundos simulados.`,
        { field: "ttl_seconds" },
      );
    }

    const outcome = await withProductLock(input.productId, () =>
      withTransaction(async (tx) => {
        const ag = await getAgentSummary(tx, agentId);
        assertNotBankrupt(ag);
        await assertProductExists(tx, input.productId);

        // Reservas (§5 compra / FIFO venta).
        if (input.side === "buy") {
          await reserveBuyerCapital(tx, agentId, reserveForQty(input.qtyCent, input.limitPriceCents));
        } else {
          await inventory.reserveFifo(tx, agentId, input.productId, input.qtyCent);
        }

        const order = await orderRepository.insertOrder(tx, {
          agentId,
          productId: input.productId,
          side: input.side,
          qtyCent: input.qtyCent,
          limitPriceCents: input.limitPriceCents,
          expiresAt: expiresAtFromTtl(new Date(), input.ttlSeconds),
        });

        const placedPayload: OrderPlacedPayload = {
          order_id: order.orderId,
          agent_id: order.agentId,
          product_id: order.productId,
          side: order.side,
          qty_cent: order.qtyOriginal,
          limit_price_cents: order.limitPriceCents,
          expires_at: order.expiresAt.toISOString(),
        };
        await appendEvent(tx, { type: "order_placed", agentId, payload: placedPayload });

        // Matching (§10.1) dentro de la MISMA tx y lock.
        return matchOrder(tx, order);
      }),
    );

    // ---- Post-commit ------------------------------------------------------
    if (input.clientOrderId !== undefined) {
      try {
        await getIdemRedis().set(
          idemKey(agentId, input.clientOrderId),
          outcome.order.orderId,
          "EX",
          config.idempotencyTtlSeconds,
        );
      } catch (err) {
        log.warn({ err }, "idempotencia: SET post-commit falló");
      }
    }
    await publishTradeNotifications(outcome.trades);

    return {
      order: outcome.order,
      trades: outcome.trades.map((t) => t.trade),
      replayed: false,
    };
  },

  /**
   * Cancela una orden propia (§10.11): terminal ⇒ idempotente (200); viva ⇒
   * libera reservas, status=cancelled, order_cancelled, BankruptcyService.
   */
  async cancelOrder(agentId: string, orderId: string): Promise<CancelOrderResult> {
    // Lectura previa SOLO para conocer el producto (el lock §10.2 es por producto)
    // y cortar temprano 404/403; todo se re-verifica bajo lock + FOR UPDATE.
    const preview = await withTransaction((tx) => orderRepository.getById(tx, orderId));
    if (preview === undefined) {
      throw domainError("unknown_order", `La orden ${orderId} no existe.`);
    }
    if (preview.agentId !== agentId) {
      throw domainError("not_owner", "La orden pertenece a otro agente.");
    }

    const result = await withProductLock(preview.productId, () =>
      withTransaction(async (tx) => {
        const ag = await getAgentSummary(tx, agentId);
        assertNotBankrupt(ag);

        const order = await orderRepository.getByIdForUpdate(tx, orderId);
        if (order === undefined) {
          throw domainError("unknown_order", `La orden ${orderId} no existe.`);
        }
        if (order.agentId !== agentId) {
          throw domainError("not_owner", "La orden pertenece a otro agente.");
        }
        if (!isOpenStatus(order.status)) {
          return { order, alreadyTerminal: true as const, wentBankrupt: false, username: ag.username };
        }

        await releaseOrderReserves(tx, order);
        const updated = await orderRepository.markTerminal(tx, orderId, "cancelled");

        const payload: OrderCancelledPayload = {
          order_id: updated.orderId,
          agent_id: updated.agentId,
          product_id: updated.productId,
          qty_pending_cent: updated.qtyPending,
        };
        await appendEvent(tx, { type: "order_cancelled", agentId, payload });

        const wentBankrupt = await bankruptcy.checkAndApply(tx, agentId);
        return { order: updated, alreadyTerminal: false as const, wentBankrupt, username: ag.username };
      }),
    );

    // ---- Post-commit ------------------------------------------------------
    if (!result.alreadyTerminal) {
      const n: Notification = {
        type: "order_cancelled",
        occurred_at: new Date().toISOString(),
        payload: {
          order_id: result.order.orderId,
          agent_id: result.order.agentId,
          product_id: result.order.productId,
          qty_pending_cent: result.order.qtyPending,
        },
      };
      await safePublish("order_cancelled", () => publishToAgent(agentId, n));
      if (result.wentBankrupt) {
        await publishBankruptcyNotifications(agentId, result.username);
      }
    }
    return { order: result.order, alreadyTerminal: result.alreadyTerminal };
  },

  /** Detalle de una orden propia (404 unknown_order / 403 not_owner). */
  async getOrder(agentId: string, orderId: string): Promise<MarketOrderRow> {
    return withTransaction(async (tx) => {
      const order = await orderRepository.getById(tx, orderId);
      if (order === undefined) {
        throw domainError("unknown_order", `La orden ${orderId} no existe.`);
      }
      if (order.agentId !== agentId) {
        throw domainError("not_owner", "La orden pertenece a otro agente.");
      }
      return order;
    });
  },

  /** Órdenes propias; por defecto solo activas/parciales (openapi). */
  async listOrders(
    agentId: string,
    params: ListOrdersParams,
  ): Promise<{ items: MarketOrderRow[]; nextCursor: string | null }> {
    const beforeId = params.cursor !== undefined ? decodeCursor(params.cursor) : undefined;
    const statuses =
      params.statuses !== undefined && params.statuses.length > 0
        ? params.statuses
        : [...OPEN_ORDER_STATUSES];
    const rows = await withTransaction((tx) =>
      orderRepository.listForAgent(tx, agentId, {
        statuses,
        productId: params.productId,
        side: params.side,
        since: params.since,
        beforeId,
        limit: params.limit,
      }),
    );
    return buildPage(rows, params.limit, (r) => r.orderId);
  },

  /** Trades de una orden propia (ownership ⇒ 403 not_owner). */
  async getOrderTrades(agentId: string, orderId: string): Promise<TradeRow[]> {
    return withTransaction(async (tx) => {
      const order = await orderRepository.getById(tx, orderId);
      if (order === undefined) {
        throw domainError("unknown_order", `La orden ${orderId} no existe.`);
      }
      if (order.agentId !== agentId) {
        throw domainError("not_owner", "La orden pertenece a otro agente.");
      }
      return tradeRepository.listByOrder(tx, orderId);
    });
  },

  /**
   * Sweep de expiración para el worker (§10.6): hasta `limit` órdenes vivas
   * vencidas ⇒ expired + liberación de reservas + order_expired (evento y
   * notificación post-commit) + BankruptcyService tras cada una. Devuelve el
   * número de órdenes expiradas (las notificaciones ya salieron desde aquí).
   *
   * NO usa el lock de producto (§10.2): transacciones cortas POR ORDEN con
   * SELECT ... FOR UPDATE que re-verifica status y vencimiento en el WHERE;
   * el matching filtra expires_at > now(), así que no hay carrera.
   */
  async expireOverdue(limit: number): Promise<number> {
    const candidateIds = await withTransaction((tx) =>
      orderRepository.findExpiredCandidateIds(tx, limit),
    );
    let expiredCount = 0;

    for (const orderId of candidateIds) {
      const res = await withTransaction(async (tx) => {
        const order = await orderRepository.lockOpenExpired(tx, orderId);
        if (order === undefined) return null; // casada/cancelada/expirada entre medio

        await releaseOrderReserves(tx, order);
        const updated = await orderRepository.markTerminal(tx, orderId, "expired");

        const payload: OrderExpiredPayload = {
          order_id: updated.orderId,
          agent_id: updated.agentId,
          product_id: updated.productId,
          qty_pending_cent: updated.qtyPending,
        };
        await appendEvent(tx, { type: "order_expired", agentId: updated.agentId, payload });

        const wentBankrupt = await bankruptcy.checkAndApply(tx, updated.agentId);
        let username: string | null = null;
        if (wentBankrupt) {
          const rows = await tx
            .select({ username: agent.username })
            .from(agent)
            .where(eq(agent.agentId, updated.agentId))
            .limit(1);
          username = rows[0]?.username ?? null;
        }
        return { order: updated, wentBankrupt, username };
      });
      if (res === null) continue;

      // ---- Post-commit por orden -----------------------------------------
      const n: Notification = {
        type: "order_expired",
        occurred_at: new Date().toISOString(),
        payload: {
          order_id: res.order.orderId,
          agent_id: res.order.agentId,
          product_id: res.order.productId,
          qty_pending_cent: res.order.qtyPending,
        },
      };
      await safePublish("order_expired", () => publishToAgent(res.order.agentId, n));
      if (res.wentBankrupt && res.username !== null) {
        await publishBankruptcyNotifications(res.order.agentId, res.username);
      }

      expiredCount += 1;
    }
    return expiredCount;
  },
};
