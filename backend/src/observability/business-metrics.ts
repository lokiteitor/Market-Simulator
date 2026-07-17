/**
 * Métricas de negocio scrape-time (gauges) — estado agregado del mercado.
 *
 * IMPORTANTE: importar SOLO desde el proceso core (server.ts), NO desde el
 * worker. Registra gauges sobre el `register` compartido; sus valores se
 * calculan en cada scrape de Prometheus consultando `monitoringRepository`.
 *
 * Para no golpear la DB una vez por gauge en cada scrape, el lote de agregados
 * se memoiza brevemente (CACHE_TTL_MS): una sola pasada de `registry.metrics()`
 * dispara todos los collect() casi a la vez y comparten una única consulta.
 */
import { Gauge } from "prom-client";
import { sql } from "drizzle-orm";
import { withTransaction, type Tx } from "../db";
import { agent, transformationProcess } from "../db/schema";
import { bankRepository } from "../repositories/bank-repository";
import { depositRepository } from "../repositories/deposit-repository";
import { feeLedgerRepository } from "../repositories/fee-ledger-repository";
import {
  monitoringRepository,
  type AgentsByRoleView,
  type MarketProductView,
  type OverviewView,
} from "../repositories/monitoring-repository";
import { logger } from "./logger";
import { register } from "./metrics";

const log = logger.child({ component: "business-metrics" });

/** Estado del patrón oro para gauges (null si la corrida no lo tiene sembrado). */
interface GoldView {
  parityCentsPerUnit: number;
  windowBidCents: number;
  windowAskCents: number;
  bankCapitalCents: number;
  bankGoldQtyCent: number;
  depositRemainingCent: number | null;
  moneyIssuedCents: number;
  moneyBurnedCents: number;
  /** Σ capital TODOS + Σ salarios − inicial − emitido + destruido (debe ser 0). */
  conservationDeltaCents: number;
}

async function fetchGoldView(tx: Tx): Promise<GoldView | null> {
  const gs = await bankRepository.getGoldStandard(tx);
  if (gs === undefined) return null;
  const bankRow = await bankRepository.findAgent(tx, gs.bankAgentId);
  const bankGoldQtyCent = await bankRepository.getGoldAvailable(tx, gs.bankAgentId, gs.productId);
  const depositRemainingCent = (await depositRepository.getRemaining(tx, gs.productId)) ?? null;
  const moneyRows = await tx
    .select({
      allMoney: sql<
        string | number
      >`coalesce(sum(${agent.capitalAvailable} + ${agent.capitalReserved}), 0)`,
    })
    .from(agent);
  const wageRows = await tx
    .select({
      wages: sql<string | number>`coalesce(sum(${transformationProcess.wagePaidCents}), 0)`,
    })
    .from(transformationProcess);
  const allMoney = Number(moneyRows[0]?.allMoney ?? 0);
  const wages = Number(wageRows[0]?.wages ?? 0);
  // Fees anotados en fee_ledger aún no plegados a la fila del banco (ADR-019):
  // parte del saldo del banco y de la masa monetaria del invariante.
  const pendingFees = await feeLedgerRepository.sumUnmaterialized(tx);
  return {
    parityCentsPerUnit: gs.parityCentsPerUnit,
    windowBidCents: gs.windowBidCents,
    windowAskCents: gs.windowAskCents,
    bankCapitalCents:
      (bankRow?.capitalAvailable ?? 0) + (bankRow?.capitalReserved ?? 0) + pendingFees,
    bankGoldQtyCent,
    depositRemainingCent,
    moneyIssuedCents: gs.moneyIssuedCents,
    moneyBurnedCents: gs.moneyBurnedCents,
    conservationDeltaCents:
      allMoney +
      pendingFees +
      wages -
      gs.initialMoneyCents -
      gs.moneyIssuedCents +
      gs.moneyBurnedCents,
  };
}

interface BusinessSnapshot {
  overview: OverviewView;
  byRole: AgentsByRoleView[];
  market: MarketProductView[];
  gold: GoldView | null;
}

const CACHE_TTL_MS = 2_000;
let cache: { at: number; data: BusinessSnapshot } | null = null;
let inFlight: Promise<BusinessSnapshot | null> | null = null;

async function fetchSnapshot(): Promise<BusinessSnapshot | null> {
  const now = Date.now();
  if (cache !== null && now - cache.at < CACHE_TTL_MS) return cache.data;
  // Coalescer scrapes concurrentes en una sola consulta.
  if (inFlight !== null) return inFlight;
  inFlight = (async () => {
    try {
      const data = await withTransaction(
        async (tx) => ({
          overview: await monitoringRepository.overview(tx),
          byRole: await monitoringRepository.agentsByRole(tx),
          market: await monitoringRepository.marketByProduct(tx),
          gold: await fetchGoldView(tx),
        }),
        { isolationLevel: "repeatable read" },
      );
      cache = { at: Date.now(), data };
      return data;
    } catch (err) {
      log.warn({ err }, "fallo consultando agregados de negocio para métricas");
      return cache?.data ?? null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// ---------------------------------------------------------------------------
// Gauges. Cada uno resetea sus series y las re-puebla en cada scrape para no
// dejar labels obsoletos (p. ej. un producto sin libro deja de emitir).
//
// Labels de producto: `product` = nombre legible (el que agrupa Grafana),
// `product_id` = UUID. Misma convención que los contadores de metrics.ts, que
// resuelven el nombre vía product-names.ts; aquí ya viene en el snapshot.
// ---------------------------------------------------------------------------

function productLabels(p: MarketProductView): { product: string; product_id: string } {
  return { product: p.name, product_id: p.productId };
}

new Gauge({
  name: "market_active_agents",
  help: "Agentes activos por rol (excluye admin)",
  labelNames: ["role"] as const,
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null) return;
    this.reset();
    for (const r of s.byRole) this.set({ role: r.role }, r.activeAgents);
  },
});

new Gauge({
  name: "market_total_capital_cents",
  help: "Capital total (available+reserved) por rol de mercado",
  labelNames: ["role"] as const,
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null) return;
    this.reset();
    for (const r of s.byRole) this.set({ role: r.role }, r.totalCapitalCents);
  },
});

new Gauge({
  name: "market_open_orders",
  help: "Órdenes abiertas (active/partial, no expiradas) en el libro",
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null) return;
    this.set(s.overview.openOrders);
  },
});

new Gauge({
  name: "market_active_processes",
  help: "Procesos de transformación en curso (running)",
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null) return;
    this.set(s.overview.activeProcesses);
  },
});

new Gauge({
  name: "market_book_depth_units",
  help: "Profundidad del libro (Σ qty_pending) por producto y lado",
  labelNames: ["product", "product_id", "side"] as const,
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null) return;
    this.reset();
    for (const p of s.market) {
      this.set({ ...productLabels(p), side: "buy" }, p.bidDepth);
      this.set({ ...productLabels(p), side: "sell" }, p.askDepth);
    }
  },
});

new Gauge({
  name: "market_best_bid_cents",
  help: "Mejor bid vigente por producto (ausente si no hay compradores)",
  labelNames: ["product", "product_id"] as const,
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null) return;
    this.reset();
    for (const p of s.market) {
      if (p.bestBidCents !== null) this.set(productLabels(p), p.bestBidCents);
    }
  },
});

new Gauge({
  name: "market_best_ask_cents",
  help: "Mejor ask vigente por producto (ausente si no hay vendedores)",
  labelNames: ["product", "product_id"] as const,
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null) return;
    this.reset();
    for (const p of s.market) {
      if (p.bestAskCents !== null) this.set(productLabels(p), p.bestAskCents);
    }
  },
});

new Gauge({
  name: "market_inventory_units",
  help: "Inventario total del sistema (Σ disponible+reservado) por producto",
  labelNames: ["product", "product_id"] as const,
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null) return;
    this.reset();
    for (const p of s.market) this.set(productLabels(p), p.totalInventory);
  },
});

// ---------------------------------------------------------------------------
// Patrón oro: banco central, yacimiento e invariante de conservación.
// Gauges sin series cuando la corrida no tiene gold_standard sembrado.
// ---------------------------------------------------------------------------

new Gauge({
  name: "market_gold_parity_cents",
  help: "Paridad de la ventanilla por lado (bid/parity/ask), en cents por unidad de oro",
  labelNames: ["kind"] as const,
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null || s.gold === null) return;
    this.reset();
    this.set({ kind: "bid" }, s.gold.windowBidCents);
    this.set({ kind: "parity" }, s.gold.parityCentsPerUnit);
    this.set({ kind: "ask" }, s.gold.windowAskCents);
  },
});

new Gauge({
  name: "market_bank_capital_cents",
  help: "Capital del banco central (fees acumulados menos emisión financiada)",
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null || s.gold === null) return;
    this.set(s.gold.bankCapitalCents);
  },
});

new Gauge({
  name: "market_bank_gold_cent",
  help: "Reserva de oro del banco central (centésimas de unidad disponibles)",
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null || s.gold === null) return;
    this.set(s.gold.bankGoldQtyCent);
  },
});

new Gauge({
  name: "market_gold_deposit_remaining_cent",
  help: "Yacimiento de oro minable restante (centésimas de unidad)",
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null || s.gold === null || s.gold.depositRemainingCent === null) return;
    this.set(s.gold.depositRemainingCent);
  },
});

new Gauge({
  name: "market_money_issued_cents",
  help: "Dinero acuñado post-seed (sell_gold + emisión de registros)",
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null || s.gold === null) return;
    this.set(s.gold.moneyIssuedCents);
  },
});

new Gauge({
  name: "market_money_burned_cents",
  help: "Dinero destruido post-seed (buy_gold)",
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null || s.gold === null) return;
    this.set(s.gold.moneyBurnedCents);
  },
});

new Gauge({
  name: "market_conservation_delta_cents",
  help: "Invariante de conservación de la masa monetaria (debe ser 0 constante)",
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null || s.gold === null) return;
    this.set(s.gold.conservationDeltaCents);
  },
});

/** No exporta nada: el import ejecuta el registro de gauges (side-effect). */
export const businessMetricsRegistered = true;
