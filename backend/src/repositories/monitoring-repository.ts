/**
 * Repositorio de monitoreo (panel admin) — agregados de solo-lectura del estado
 * global del mercado, agentes/bots y volúmenes productivos.
 *
 * Reglas del proyecto:
 *  - Todas las funciones reciben `tx: Tx` como primer parámetro; las
 *    transacciones se abren SOLO en services (contrato §0). Como son lecturas,
 *    el service las corre en una tx de solo-lectura.
 *  - Los agregados de MERCADO excluyen el rol `admin` (solo-monitoreo, capital
 *    0): usan `ne(agent.role, 'admin')`. Reutiliza el mismo criterio que
 *    snapshot-runner.ts y agent-repository.averageActiveTotalCapitalCents.
 *  - postgres.js devuelve BIGINT/numeric como string: se normaliza con num().
 */
import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "../db";
import {
  agent,
  inventoryLot,
  marketOrder,
  marketSnapshot,
  product,
  recipe,
  trade,
  transformationProcess,
} from "../db/schema";

// ---------------------------------------------------------------------------
// Normalización de agregados (BIGINT string → number)
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

/** Ventana temporal reutilizable para agregados "últimas 24h". */
const WINDOW_24H = sql`now() - interval '24 hours'`;

// ---------------------------------------------------------------------------
// Vistas de dominio (camelCase; el controller las convierte a snake_case)
// ---------------------------------------------------------------------------

export interface OverviewView {
  activeAgents: number;
  bankruptAgents: number;
  totalCapitalCents: number;
  feesCollectedCents: number;
  activeProcesses: number;
  openOrders: number;
  tradeVolume24h: number;
  trades24h: number;
}

export interface AgentsByRoleView {
  role: string;
  activeAgents: number;
  bankruptAgents: number;
  totalCapitalCents: number;
}

export interface AgentListItemView {
  agentId: string;
  username: string;
  role: string;
  status: string;
  capitalAvailableCents: number;
  capitalReservedCents: number;
  registeredAt: Date;
}

export interface AgentsPage {
  rows: AgentListItemView[];
  total: number;
}

export interface MarketProductView {
  productId: string;
  name: string;
  unit: string;
  category: string;
  bestBidCents: number | null;
  bestAskCents: number | null;
  bidDepth: number;
  askDepth: number;
  totalInventory: number;
  tradeVolume24h: number;
  vwap24hCents: number | null;
  trades24h: number;
}

export interface ProductionRecipeView {
  recipeId: string;
  recipeName: string;
  outputProductId: string;
  outputProductName: string;
  activeProcesses: number;
  plannedExecutions: number;
  wagePaidCents: number;
}

export interface ProducedProductView {
  productId: string;
  name: string;
  unit: string;
  producedUnits24h: number;
}

export interface ProductionView {
  recipes: ProductionRecipeView[];
  produced: ProducedProductView[];
}

export interface SnapshotPointView {
  snapshotId: string;
  takenAt: Date;
  activeAgents: number;
  totalMoneyCents: number;
  feesCollectedCents: number;
}

// ---------------------------------------------------------------------------
// Repositorio
// ---------------------------------------------------------------------------

const NOT_ADMIN = ne(agent.role, "admin");
const OPEN_ORDER_STATUSES = ["active", "partial"] as const;

export const monitoringRepository = {
  /** KPIs de cabecera del panel admin. */
  async overview(tx: Tx): Promise<OverviewView> {
    // Agentes (excluye admins) + capital total de mercado.
    const agentRows = await tx
      .select({
        activeAgents: sql<
          string | number
        >`count(*) filter (where ${agent.status} = 'active')`,
        bankruptAgents: sql<
          string | number
        >`count(*) filter (where ${agent.status} = 'bankrupt')`,
        totalCapitalCents: sql<
          string | number
        >`coalesce(sum(${agent.capitalAvailable} + ${agent.capitalReserved}), 0)`,
      })
      .from(agent)
      .where(NOT_ADMIN);

    const feeRows = await tx
      .select({
        feesCollectedCents: sql<
          string | number
        >`coalesce(sum(${trade.feeBuyerCents} + ${trade.feeSellerCents}), 0)`,
      })
      .from(trade);

    const processRows = await tx
      .select({
        activeProcesses: sql<string | number>`count(*)`,
      })
      .from(transformationProcess)
      .where(eq(transformationProcess.status, "running"));

    const orderRows = await tx
      .select({ openOrders: sql<string | number>`count(*)` })
      .from(marketOrder)
      .where(
        and(
          inArray(marketOrder.status, [...OPEN_ORDER_STATUSES]),
          gt(marketOrder.expiresAt, sql`now()`),
        ),
      );

    const vol24hRows = await tx
      .select({
        volume: sql<string | number>`coalesce(sum(${trade.qtyExecuted}), 0)`,
        trades: sql<string | number>`count(*)`,
      })
      .from(trade)
      .where(gt(trade.executedAt, WINDOW_24H));

    const a = agentRows[0];
    return {
      activeAgents: num(a?.activeAgents),
      bankruptAgents: num(a?.bankruptAgents),
      totalCapitalCents: num(a?.totalCapitalCents),
      feesCollectedCents: num(feeRows[0]?.feesCollectedCents),
      activeProcesses: num(processRows[0]?.activeProcesses),
      openOrders: num(orderRows[0]?.openOrders),
      tradeVolume24h: num(vol24hRows[0]?.volume),
      trades24h: num(vol24hRows[0]?.trades),
    };
  },

  /** Desglose de agentes por rol de mercado (excluye admin). */
  async agentsByRole(tx: Tx): Promise<AgentsByRoleView[]> {
    const rows = await tx
      .select({
        role: agent.role,
        activeAgents: sql<
          string | number
        >`count(*) filter (where ${agent.status} = 'active')`,
        bankruptAgents: sql<
          string | number
        >`count(*) filter (where ${agent.status} = 'bankrupt')`,
        totalCapitalCents: sql<
          string | number
        >`coalesce(sum(${agent.capitalAvailable} + ${agent.capitalReserved}), 0)`,
      })
      .from(agent)
      .where(NOT_ADMIN)
      .groupBy(agent.role);
    return rows.map((r) => ({
      role: r.role,
      activeAgents: num(r.activeAgents),
      bankruptAgents: num(r.bankruptAgents),
      totalCapitalCents: num(r.totalCapitalCents),
    }));
  },

  /**
   * Listado paginado de agentes/bots de mercado (excluye admin). Filtros
   * opcionales por rol y estado. `total` es el conteo con los mismos filtros.
   */
  async listAgents(
    tx: Tx,
    opts: {
      limit: number;
      offset: number;
      role?: string;
      status?: "active" | "bankrupt";
    },
  ): Promise<AgentsPage> {
    const filters = [NOT_ADMIN];
    if (opts.role !== undefined) {
      filters.push(eq(agent.role, opts.role as (typeof agent.role.enumValues)[number]));
    }
    if (opts.status !== undefined) filters.push(eq(agent.status, opts.status));
    const where = and(...filters);

    const rows = await tx
      .select({
        agentId: agent.agentId,
        username: agent.username,
        role: agent.role,
        status: agent.status,
        capitalAvailableCents: agent.capitalAvailable,
        capitalReservedCents: agent.capitalReserved,
        registeredAt: agent.registeredAt,
      })
      .from(agent)
      .where(where)
      .orderBy(desc(agent.registeredAt), asc(agent.agentId))
      .limit(opts.limit)
      .offset(opts.offset);

    const totalRows = await tx
      .select({ total: sql<string | number>`count(*)` })
      .from(agent)
      .where(where);

    return {
      rows: rows.map((r) => ({
        agentId: r.agentId,
        username: r.username,
        role: r.role,
        status: r.status,
        capitalAvailableCents: num(r.capitalAvailableCents),
        capitalReservedCents: num(r.capitalReservedCents),
        registeredAt: r.registeredAt,
      })),
      total: num(totalRows[0]?.total),
    };
  },

  /**
   * Estado global del mercado por producto: top-of-book, profundidad,
   * inventario total del sistema y volumen/VWAP de las últimas 24h.
   */
  async marketByProduct(tx: Tx): Promise<MarketProductView[]> {
    const products = await tx
      .select({
        productId: product.productId,
        name: product.name,
        unit: product.unit,
        category: product.category,
      })
      .from(product)
      .orderBy(asc(product.name));

    // Libro vigente: active/partial y NO expirado (§10.6). Best bid/ask y
    // profundidad (Σ qty_pending) por lado, en una pasada.
    const books = await tx
      .select({
        productId: marketOrder.productId,
        bestBidCents: sql<
          string | number | null
        >`max(${marketOrder.limitPriceCents}) filter (where ${marketOrder.side} = 'buy')`,
        bestAskCents: sql<
          string | number | null
        >`min(${marketOrder.limitPriceCents}) filter (where ${marketOrder.side} = 'sell')`,
        bidDepth: sql<
          string | number
        >`coalesce(sum(${marketOrder.qtyPending}) filter (where ${marketOrder.side} = 'buy'), 0)`,
        askDepth: sql<
          string | number
        >`coalesce(sum(${marketOrder.qtyPending}) filter (where ${marketOrder.side} = 'sell'), 0)`,
      })
      .from(marketOrder)
      .where(
        and(
          inArray(marketOrder.status, [...OPEN_ORDER_STATUSES]),
          gt(marketOrder.expiresAt, sql`now()`),
        ),
      )
      .groupBy(marketOrder.productId);
    const bookByProduct = new Map(books.map((b) => [b.productId, b]));

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

    // Volumen y VWAP 24h. VWAP = Σ(price*qty) / Σ(qty).
    const vol = await tx
      .select({
        productId: trade.productId,
        volume: sql<string | number>`coalesce(sum(${trade.qtyExecuted}), 0)`,
        notional: sql<
          string | number
        >`coalesce(sum(${trade.priceCents} * ${trade.qtyExecuted}), 0)`,
        trades: sql<string | number>`count(*)`,
      })
      .from(trade)
      .where(gt(trade.executedAt, WINDOW_24H))
      .groupBy(trade.productId);
    const volByProduct = new Map(vol.map((r) => [r.productId, r]));

    return products.map((p) => {
      const book = bookByProduct.get(p.productId);
      const v = volByProduct.get(p.productId);
      const volume = num(v?.volume);
      const notional = num(v?.notional);
      return {
        productId: p.productId,
        name: p.name,
        unit: p.unit,
        category: p.category,
        bestBidCents: numOrNull(book?.bestBidCents ?? null),
        bestAskCents: numOrNull(book?.bestAskCents ?? null),
        bidDepth: num(book?.bidDepth),
        askDepth: num(book?.askDepth),
        totalInventory: invByProduct.get(p.productId) ?? 0,
        tradeVolume24h: volume,
        vwap24hCents: volume > 0 ? Math.round(notional / volume) : null,
        trades24h: num(v?.trades),
      };
    });
  },

  /**
   * Volúmenes productivos: procesos activos, ejecuciones planificadas y
   * salarios por receta; y unidades producidas en las últimas 24h por producto
   * (lotes con origin='production').
   */
  async production(tx: Tx): Promise<ProductionView> {
    const recipeRows = await tx
      .select({
        recipeId: recipe.recipeId,
        recipeName: recipe.name,
        outputProductId: recipe.outputProductId,
        outputProductName: product.name,
        activeProcesses: sql<
          string | number
        >`count(${transformationProcess.processId}) filter (where ${transformationProcess.status} = 'running')`,
        plannedExecutions: sql<
          string | number
        >`coalesce(sum(${transformationProcess.executionsPlanned}) filter (where ${transformationProcess.status} = 'running'), 0)`,
        wagePaidCents: sql<
          string | number
        >`coalesce(sum(${transformationProcess.wagePaidCents}), 0)`,
      })
      .from(recipe)
      .innerJoin(product, eq(product.productId, recipe.outputProductId))
      .leftJoin(transformationProcess, eq(transformationProcess.recipeId, recipe.recipeId))
      .groupBy(recipe.recipeId, recipe.name, recipe.outputProductId, product.name)
      .orderBy(asc(recipe.name));

    const producedRows = await tx
      .select({
        productId: product.productId,
        name: product.name,
        unit: product.unit,
        producedUnits24h: sql<
          string | number
        >`coalesce(sum(${inventoryLot.qtyOriginal}) filter (where ${inventoryLot.origin} = 'production' and ${inventoryLot.acquiredAt} > ${WINDOW_24H}), 0)`,
      })
      .from(product)
      .leftJoin(inventoryLot, eq(inventoryLot.productId, product.productId))
      .groupBy(product.productId, product.name, product.unit)
      .orderBy(asc(product.name));

    return {
      recipes: recipeRows.map((r) => ({
        recipeId: r.recipeId,
        recipeName: r.recipeName,
        outputProductId: r.outputProductId,
        outputProductName: r.outputProductName,
        activeProcesses: num(r.activeProcesses),
        plannedExecutions: num(r.plannedExecutions),
        wagePaidCents: num(r.wagePaidCents),
      })),
      produced: producedRows.map((r) => ({
        productId: r.productId,
        name: r.name,
        unit: r.unit,
        producedUnits24h: num(r.producedUnits24h),
      })),
    };
  },

  /**
   * Serie temporal de snapshots de mercado (para las gráficas de tendencia).
   * Devuelve los más recientes primero acotado por `limit`; el service puede
   * invertir el orden para graficar cronológicamente.
   */
  async snapshotSeries(tx: Tx, opts: { limit: number }): Promise<SnapshotPointView[]> {
    const rows = await tx
      .select({
        snapshotId: marketSnapshot.snapshotId,
        takenAt: marketSnapshot.takenAt,
        activeAgents: marketSnapshot.activeAgents,
        totalMoneyCents: marketSnapshot.totalMoneyCents,
        feesCollectedCents: marketSnapshot.feesCollectedCents,
      })
      .from(marketSnapshot)
      .orderBy(desc(marketSnapshot.takenAt))
      .limit(opts.limit);
    return rows.map((r) => ({
      snapshotId: r.snapshotId,
      takenAt: r.takenAt,
      activeAgents: num(r.activeAgents),
      totalMoneyCents: num(r.totalMoneyCents),
      feesCollectedCents: num(r.feesCollectedCents),
    }));
  },
};
