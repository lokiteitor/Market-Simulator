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
import { acquireProductAdvisoryLock, withTransaction, type Tx } from "../db";
import { agent, product, type MarketOrderRow, type TradeRow } from "../db/schema";
import { decodeCursor } from "../lib/cursor";
import { DomainError, domainError } from "../lib/errors";
import {
  appendEvent,
  type OrderCancelledPayload,
  type OrderExpiredPayload,
  type OrderPlacedPayload,
} from "../lib/event-log";
import { withProductLock } from "../lib/locks";
import { notionalCents, reserveForQty } from "../lib/money";
import { expiresAtFromTtl } from "../lib/simtime";
import { publishBroadcast, publishToAgent, publishToProduct, type Notification } from "../notifier";
import { logger } from "../observability/logger";
import { tradesExecutedTotal, tradeVolumeUnitsTotal } from "../observability/metrics";
import { productLabels } from "../observability/product-names";
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
import { bankRepository } from "../repositories/bank-repository";
import { feeLedgerRepository } from "../repositories/fee-ledger-repository";
import { matchOrder, type ExecutedTrade, type MatchOutcome } from "./matching/engine";
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

/**
 * Libera el reclamo de idempotencia tras un fallo de la tx, SOLO si la clave
 * aún contiene el placeholder propio, para no bloquear reintentos legítimos
 * del cliente durante todo el TTL.
 *
 * GET+compare+DEL (sin script Lua) es suficiente aquí: mientras el placeholder
 * propio vive, ninguna otra request puede escribir la clave — el reclamo se
 * hace con SET NX (falla si la clave existe) y el único SET XX post-commit lo
 * ejecuta la request que ostenta el reclamo (esta misma, que ya falló). La
 * única escritura ajena posible es la expiración del TTL, y borrar una clave
 * ya expirada es inocuo. Best-effort: un fallo de Redis solo se loguea (la
 * clave expira sola por TTL).
 */
async function releaseIdemClaim(key: string, placeholder: string): Promise<void> {
  try {
    const current = await getIdemRedis().get(key);
    if (current === placeholder) {
      await getIdemRedis().del(key);
    }
  } catch (err) {
    log.warn({ err }, "idempotencia: no se pudo liberar el placeholder tras fallo de la tx");
  }
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
    // openapi manda: POST /orders solo declara 422 para fallos de dominio
    // ("producto desconocido" incluido); el 404 de unknown_product queda para
    // los GET de catálogo/mercado.
    throw new DomainError({
      code: "unknown_product",
      status: 422,
      title: "Producto desconocido",
      detail: `El producto ${productId} no existe.`,
      field: "product_id",
    });
  }
}

/**
 * ¿Es un deadlock de Postgres (SQLSTATE 40P01)? El PostgresError puede llegar
 * directo o envuelto (drizzle 0.45 lo deja en `err.cause` de DrizzleQueryError);
 * se recorre la cadena de causas con profundidad acotada.
 */
function isDeadlockError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === "40P01") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Reintenta la operación completa (lock de producto + tx) ante deadlock 40P01,
 * hasta `retries` veces con un jitter breve.
 *
 * Motivo — ciclo AB-BA sobre filas de `agent` entre matchings cross-producto:
 * placeOrder bloquea la fila del taker al reservar (reserveBuyerCapital) y el
 * engine bloquea la de la contraparte recién en el fill; dos matchings
 * simultáneos en productos DISTINTOS con roles invertidos toman esas filas en
 * orden opuesto y Postgres aborta una tx con 40P01. El rollback restaura
 * reservas/capital y el SET de idempotencia es post-commit, así que reintentar
 * desde cero es seguro (withProductLock se re-adquiere en cada intento).
 */
async function retryOnDeadlock<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isDeadlockError(err)) throw err;
      const jitterMs = 5 + Math.floor(Math.random() * 25);
      log.warn({ attempt: attempt + 1, jitterMs }, "deadlock 40P01 detectado; reintentando la operación");
      await new Promise((resolve) => setTimeout(resolve, jitterMs));
    }
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
    // Métricas de negocio (post-commit: solo trades ya persistidos).
    const labels = await productLabels(e.trade.productId);
    tradesExecutedTotal.inc(labels);
    tradeVolumeUnitsTotal.inc(labels, e.trade.qtyExecuted);

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
    // Tape público POR PRODUCTO (fan-out selectivo): solo lo reciben los
    // clientes suscritos a este producto (o al firehose `product:*`). Los
    // trades ya son visibles vía GET /market/{id}/trades con ambas
    // identidades, así que el canal no revela nada nuevo.
    await safePublish("trade_printed product", () =>
      publishToProduct(e.trade.productId, {
        type: "trade_printed",
        occurred_at: occurredAt,
        payload: base,
      }),
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
   * reclamo idem (SET NX) → validaciones → reserva → INSERT → order_placed →
   * matching → post-commit (idem SET XX + notificaciones order_executed).
   */
  async placeOrder(agentId: string, input: PlaceOrderInput): Promise<PlaceOrderResult> {
    // Idempotencia (§10.7): reclamo ATÓMICO de la clave con SET NX ANTES de
    // crear, con placeholder "pending:<reqId>" que marca la request original en
    // vuelo (cierra la carrera check-then-act de dos POST concurrentes):
    //   - NX ok  ⇒ este request es el original; post-commit sobreescribe con el
    //     order_id real (SET XX).
    //   - clave con order_id ⇒ replay: 200 con la orden releída, sin re-matching.
    //   - clave con placeholder ajeno ⇒ 409 conflict_state (el original sigue
    //     en vuelo; su resultado quedará en la clave para el replay).
    // Best-effort: si Redis está caído, se loguea y se degrada al flujo sin
    // idempotencia (igual que antes).
    const idemPlaceholder = `pending:${crypto.randomUUID()}`;
    let idemClaimed = false;
    if (input.clientOrderId !== undefined) {
      const key = idemKey(agentId, input.clientOrderId);
      let existingOrderId: string | null = null;
      try {
        const claimed = await getIdemRedis().set(
          key,
          idemPlaceholder,
          "EX",
          config.idempotencyTtlSeconds,
          "NX",
        );
        if (claimed !== null) {
          idemClaimed = true;
        } else {
          const current = await getIdemRedis().get(key);
          if (current !== null && current.startsWith("pending:")) {
            throw domainError(
              "conflict_state",
              "Ya hay una orden en vuelo con el mismo client_order_id; reintenta cuando termine.",
              { field: "client_order_id" },
            );
          }
          // current === null ⇒ clave expirada entre SET y GET: se continúa
          // colocando la orden sin reclamo (mismo best-effort de siempre).
          existingOrderId = current;
        }
      } catch (err) {
        if (err instanceof DomainError) throw err;
        log.warn({ err }, "idempotencia: reclamo SET NX falló; se continúa colocando la orden");
      }
      if (existingOrderId !== null) {
        // Valor = order_id de la orden ya creada ⇒ replay 200 sin re-matching.
        const oid = existingOrderId;
        const existing = await withTransaction((tx) => orderRepository.getById(tx, oid));
        if (existing !== undefined && existing.agentId === agentId) {
          return { order: existing, trades: [], replayed: true };
        }
        // order_id huérfano: se continúa colocando la orden (best-effort).
      }
    }

    let outcome: MatchOutcome;
    try {
      // TTL (§10.5) ⇒ 422 ttl_out_of_range.
      const { minSimSeconds, maxSimSeconds } = config.orderTtl;
      if (input.ttlSeconds < minSimSeconds || input.ttlSeconds > maxSimSeconds) {
        throw domainError(
          "ttl_out_of_range",
          `ttl_seconds debe estar entre ${minSimSeconds} y ${maxSimSeconds} segundos simulados.`,
          { field: "ttl_seconds" },
        );
      }

      outcome = await retryOnDeadlock(() =>
        withProductLock(input.productId, () =>
          withTransaction(async (tx) => {
            // §10.2 (ADR-019): advisory lock por producto, cluster-wide, como
            // PRIMER lock de la tx (antes que gold_standard y filas de agente).
            await acquireProductAdvisoryLock(tx, input.productId);
            const ag = await getAgentSummary(tx, agentId);
            assertNotBankrupt(ag);
            await assertProductExists(tx, input.productId);

            // Reservas (§5 compra / FIFO venta).
            if (input.side === "buy") {
              const reserveCents = reserveForQty(input.qtyCent, input.limitPriceCents);
              if (reserveCents === 0) {
                // Nocional sub-centavo: floor(qty×price/100)=0 reservaría 0 y
                // permitiría comprar mercancía a costo 0 burlando la
                // validación de capital del §5 ⇒ 422 (validación de dominio).
                throw domainError(
                  "insufficient_capital",
                  `El nocional de la orden (qty_cent=${input.qtyCent} × limit_price_cents=${input.limitPriceCents} / 100) ` +
                    "redondea a 0 centavos; qty_cent × limit_price_cents debe ser ≥ 100 (al menos 1 centavo reservable).",
                  { field: "qty_cent" },
                );
              }
              await reserveBuyerCapital(tx, agentId, reserveCents);
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
            const matched = await matchOrder(tx, order);

            // Patrón oro (ADR-019): los fees NO se evaporan, pero YA NO se
            // acreditan con UPDATE de la fila del banco (fila caliente global que
            // serializaría todos los trades de todas las réplicas). En su lugar
            // se ANOTAN en fee_ledger (append-only, sin contención); el sweeper
            // del Worker los pliega al capital del banco. Si la corrida no tiene
            // gold_standard (DB antigua) no hay banco a quien acreditar ⇒ se
            // comportan como antes (no se anotan; se evaporan).
            const bankAgentId = await bankRepository.getBankAgentId(tx);
            if (bankAgentId !== null) {
              for (const t of matched.trades) {
                const feeCents = t.trade.feeBuyerCents + t.trade.feeSellerCents;
                if (feeCents > 0) {
                  await feeLedgerRepository.insertFee(tx, {
                    tradeId: t.trade.tradeId,
                    amountCents: feeCents,
                  });
                }
              }
            }
            return matched;
          }),
        ),
      );
    } catch (err) {
      // Fallo sin commit (validación 422, quiebra, deadlock agotado…): liberar
      // el reclamo (solo si sigue siendo el placeholder propio) para no
      // bloquear con 409 los reintentos legítimos durante todo el TTL.
      if (idemClaimed && input.clientOrderId !== undefined) {
        await releaseIdemClaim(idemKey(agentId, input.clientOrderId), idemPlaceholder);
      }
      throw err;
    }

    // ---- Post-commit ------------------------------------------------------
    if (input.clientOrderId !== undefined) {
      try {
        // XX: solo sobreescribe una clave existente (el placeholder propio o un
        // order_id previo); si el reclamo no existe (Redis caído al reclamar o
        // clave expirada) no se inventa una entrada nueva.
        await getIdemRedis().set(
          idemKey(agentId, input.clientOrderId),
          outcome.order.orderId,
          "EX",
          config.idempotencyTtlSeconds,
          "XX",
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

    const result = await retryOnDeadlock(() =>
      withProductLock(preview.productId, () =>
        withTransaction(async (tx) => {
          // §10.2 (ADR-019): advisory lock por producto como primer lock de la tx.
          await acquireProductAdvisoryLock(tx, preview.productId);
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
            return {
              order,
              alreadyTerminal: true as const,
              wentBankrupt: false,
              username: ag.username,
            };
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
          return {
            order: updated,
            alreadyTerminal: false as const,
            wentBankrupt,
            username: ag.username,
          };
        }),
      ),
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
