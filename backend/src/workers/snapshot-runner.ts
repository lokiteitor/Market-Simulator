/**
 * SnapshotRunner (contrato §14, arquitectura §5.3, diseño §"Snapshots agregados").
 *
 * Job on-demand: calcula agregados del mercado y los persiste en una única
 * transacción atómica:
 *   - market_snapshot: active_agents, total_money_cents (Σ capital
 *     available+reserved de TODOS los agentes; los bankrupt quedan en 0 por la
 *     condición de quiebra §8, así que sumar todos == sumar activos),
 *     fees_collected_cents (Σ fee_buyer_cents + fee_seller_cents de trade),
 *     note opcional.
 *   - market_snapshot_agent_capital: capital total por agente.
 *   - market_snapshot_product: por CADA producto del catálogo, inventario
 *     total del sistema (Σ qty_available + qty_reserved de los lotes) y mejor
 *     bid/ask del libro vigente (órdenes active/partial NO expiradas, §10.6);
 *     NULL si no hay órdenes de ese lado.
 *   - event_log: snapshot_taken {snapshot_id, note} (§9), en la misma tx.
 *
 * No publica notificaciones: snapshot_taken no es un NotificationType (§9).
 */
import { and, gt, inArray, sql } from "drizzle-orm";
import { withTransaction } from "../db";
import {
  agent,
  inventoryLot,
  marketOrder,
  marketSnapshot,
  marketSnapshotAgentCapital,
  marketSnapshotProduct,
  product,
  trade,
} from "../db/schema";
import type { SnapshotTakenPayload } from "../lib/event-log";
import { appendEvent } from "../lib/event-log";
import { logger } from "../observability/logger";

const log = logger.child({ component: "snapshot-runner" });

/** Resumen del snapshot persistido (valor de retorno del job BullMQ). */
export interface SnapshotResult {
  snapshotId: string;
  /** ISO 8601 (serializable como retorno de job). */
  takenAt: string;
  note: string | null;
  activeAgents: number;
  totalMoneyCents: number;
  feesCollectedCents: number;
  agentsSnapshotted: number;
  productsSnapshotted: number;
}

/**
 * Los agregados SQL (count/sum/max/min sobre BIGINT) llegan del driver como
 * string (postgres.js devuelve int8/numeric como texto); se normalizan aquí.
 */
function num(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`snapshot: agregado no numérico: ${String(v)}`);
  }
  return n;
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

/** Trocea inserts masivos para no acercarse al límite de parámetros de Postgres. */
function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

const INSERT_CHUNK_SIZE = 1000;

/** Calcula y persiste un snapshot completo del mercado. */
export async function runSnapshot(note?: string | null): Promise<SnapshotResult> {
  const normalizedNote =
    note !== null && note !== undefined && note.trim().length > 0 ? note.trim() : null;

  const result = await withTransaction(async (tx) => {
    // --- Agregados de cabecera -------------------------------------------
    const agentAggRows = await tx
      .select({
        activeAgents: sql<string | number>`count(*) filter (where ${agent.status} = 'active')`,
        totalMoneyCents: sql<
          string | number
        >`coalesce(sum(${agent.capitalAvailable} + ${agent.capitalReserved}), 0)`,
      })
      .from(agent);
    const feeAggRows = await tx
      .select({
        feesCollectedCents: sql<
          string | number
        >`coalesce(sum(${trade.feeBuyerCents} + ${trade.feeSellerCents}), 0)`,
      })
      .from(trade);

    const activeAgents = num(agentAggRows[0]?.activeAgents ?? 0);
    const totalMoneyCents = num(agentAggRows[0]?.totalMoneyCents ?? 0);
    const feesCollectedCents = num(feeAggRows[0]?.feesCollectedCents ?? 0);

    const insertedHead = await tx
      .insert(marketSnapshot)
      .values({
        activeAgents,
        totalMoneyCents,
        feesCollectedCents,
        note: normalizedNote,
      })
      .returning({
        snapshotId: marketSnapshot.snapshotId,
        takenAt: marketSnapshot.takenAt,
      });
    const head = insertedHead[0];
    if (head === undefined) {
      throw new Error("snapshot: INSERT market_snapshot no devolvió fila");
    }

    // --- Capital total por agente ----------------------------------------
    const capitals = await tx
      .select({
        agentId: agent.agentId,
        capitalTotal: sql<string | number>`${agent.capitalAvailable} + ${agent.capitalReserved}`,
      })
      .from(agent);
    const capitalRows = capitals.map((c) => ({
      snapshotId: head.snapshotId,
      agentId: c.agentId,
      capitalTotal: num(c.capitalTotal),
    }));
    for (const chunk of chunked(capitalRows, INSERT_CHUNK_SIZE)) {
      await tx.insert(marketSnapshotAgentCapital).values(chunk);
    }

    // --- Por producto: inventario total + best bid/ask --------------------
    const products = await tx.select({ productId: product.productId }).from(product);

    const invTotals = await tx
      .select({
        productId: inventoryLot.productId,
        totalInventory: sql<
          string | number
        >`coalesce(sum(${inventoryLot.qtyAvailable} + ${inventoryLot.qtyReserved}), 0)`,
      })
      .from(inventoryLot)
      .groupBy(inventoryLot.productId);
    const invByProduct = new Map(invTotals.map((r) => [r.productId, num(r.totalInventory)]));

    // Top-of-book vigente: active/partial y NO expiradas (§10.6).
    const books = await tx
      .select({
        productId: marketOrder.productId,
        bestBidCents: sql<
          string | number | null
        >`max(${marketOrder.limitPriceCents}) filter (where ${marketOrder.side} = 'buy')`,
        bestAskCents: sql<
          string | number | null
        >`min(${marketOrder.limitPriceCents}) filter (where ${marketOrder.side} = 'sell')`,
      })
      .from(marketOrder)
      .where(
        and(
          inArray(marketOrder.status, ["active", "partial"]),
          gt(marketOrder.expiresAt, sql`now()`),
        ),
      )
      .groupBy(marketOrder.productId);
    const bookByProduct = new Map(books.map((r) => [r.productId, r]));

    const productRows = products.map((p) => {
      const book = bookByProduct.get(p.productId);
      return {
        snapshotId: head.snapshotId,
        productId: p.productId,
        totalInventory: invByProduct.get(p.productId) ?? 0,
        bestBidCents: numOrNull(book?.bestBidCents ?? null),
        bestAskCents: numOrNull(book?.bestAskCents ?? null),
      };
    });
    for (const chunk of chunked(productRows, INSERT_CHUNK_SIZE)) {
      await tx.insert(marketSnapshotProduct).values(chunk);
    }

    // --- Event log (misma tx, §0/§9) --------------------------------------
    const payload: SnapshotTakenPayload = {
      snapshot_id: head.snapshotId,
      note: normalizedNote ?? "",
    };
    await appendEvent(tx, { type: "snapshot_taken", payload });

    const summary: SnapshotResult = {
      snapshotId: head.snapshotId,
      takenAt: head.takenAt.toISOString(),
      note: normalizedNote,
      activeAgents,
      totalMoneyCents,
      feesCollectedCents,
      agentsSnapshotted: capitalRows.length,
      productsSnapshotted: productRows.length,
    };
    return summary;
  });

  log.info(
    {
      snapshotId: result.snapshotId,
      note: result.note,
      activeAgents: result.activeAgents,
      totalMoneyCents: result.totalMoneyCents,
      feesCollectedCents: result.feesCollectedCents,
      agents: result.agentsSnapshotted,
      products: result.productsSnapshotted,
    },
    "snapshot de mercado persistido",
  );
  return result;
}
