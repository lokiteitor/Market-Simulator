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
import { config } from "../config";
import { withTransaction, type Tx } from "../db";
import { agent } from "../db/schema";
import { depositYieldBps } from "../lib/deposits";
import { bankRepository } from "../repositories/bank-repository";
import { depositRepository } from "../repositories/deposit-repository";
import { feeLedgerRepository } from "../repositories/fee-ledger-repository";
import { incomeLedgerRepository } from "../repositories/income-ledger-repository";
import {
  monitoringRepository,
  type AgentsByRoleView,
  type InstallationsByTypeView,
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
  /**
   * Σ capital TODOS + fees pendientes + ingreso de ciudades pendiente
   * − inicial − emitido + destruido (debe ser 0). Los salarios YA NO figuran:
   * dejaron de destruirse y se reciclan íntegros a las ciudades (flujo
   * circular), así que viven o en income_ledger (en tránsito) o en el capital
   * de las ciudades (ya dentro de Σ capital).
   */
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
  const allMoney = Number(moneyRows[0]?.allMoney ?? 0);
  // Fees anotados en fee_ledger aún no plegados a la fila del banco (ADR-019):
  // parte del saldo del banco y de la masa monetaria del invariante.
  const pendingFees = await feeLedgerRepository.sumUnmaterialized(tx);
  // Ingreso de ciudades ya debitado del pagador (salario reciclado + tasa) pero
  // aún no repartido: dinero EN TRÁNSITO, sigue dentro del sistema.
  const pendingIncome = await incomeLedgerRepository.sumUnmaterialized(tx);
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
      pendingIncome -
      gs.initialMoneyCents -
      gs.moneyIssuedCents +
      gs.moneyBurnedCents,
  };
}

/** Yacimiento finito para gauges: remanente y rendimiento (ADR-023). */
interface DepositView {
  productId: string;
  productName: string;
  qtyInitialCent: number;
  qtyRemainingCent: number;
  yieldBps: number;
}

async function fetchDepositViews(tx: Tx): Promise<DepositView[]> {
  const rows = await depositRepository.listAll(tx);
  return rows.map((r) => ({
    productId: r.productId,
    productName: r.productName,
    qtyInitialCent: r.qtyInitialCent,
    qtyRemainingCent: r.qtyRemainingCent,
    yieldBps: depositYieldBps(
      r.qtyInitialCent,
      r.qtyRemainingCent,
      config.deposits.yieldFloorBps,
    ),
  }));
}

interface BusinessSnapshot {
  overview: OverviewView;
  byRole: AgentsByRoleView[];
  installations: InstallationsByTypeView[];
  market: MarketProductView[];
  /** Yacimientos finitos con su rendimiento actual (ADR-023). */
  deposits: DepositView[];
  gold: GoldView | null;
  /** Ingreso de ciudades pendiente de repartir, por fuente (`wage` / `tax`). */
  cityIncomePending: Array<{ source: string; cents: number }>;
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
          installations: await monitoringRepository.installationsByType(tx),
          market: await monitoringRepository.marketByProduct(tx),
          deposits: await fetchDepositViews(tx),
          gold: await fetchGoldView(tx),
          cityIncomePending: await incomeLedgerRepository.sumUnmaterializedBySource(tx),
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

// Capacidad productiva instalada (ADR-021). El nivel agregado es el techo de
// procesos concurrentes del tipo en TODO el mercado: contra el consumo del
// producto que fabrica, dice si falta capacidad o falta demanda. Con la raíz
// única del catálogo (ADR-022), `pozo_agua` es el que hay que vigilar.
new Gauge({
  name: "market_installations_count",
  help: "Agentes que han comprado cada tipo de instalación",
  labelNames: ["installation_type"] as const,
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null) return;
    this.reset();
    for (const i of s.installations) this.set({ installation_type: i.typeKey }, i.installations);
  },
});

new Gauge({
  name: "market_installations_level",
  help: "Suma de niveles por tipo de instalación (procesos concurrentes posibles)",
  labelNames: ["installation_type"] as const,
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null) return;
    this.reset();
    for (const i of s.installations) this.set({ installation_type: i.typeKey }, i.totalLevel);
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
// Yacimientos finitos (ADR-023). El rendimiento es la lectura útil: dice a qué
// ritmo se está vaciando cada recurso y, como multiplica el output de la receta,
// es también el factor por el que se encarece producirlo.
// ---------------------------------------------------------------------------

new Gauge({
  name: "market_deposit_remaining_cent",
  help: "Remanente del yacimiento por recurso no renovable (centésimas de unidad)",
  labelNames: ["product", "product_id"] as const,
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null) return;
    this.reset();
    for (const d of s.deposits) {
      this.set({ product: d.productName, product_id: d.productId }, d.qtyRemainingCent);
    }
  },
});

new Gauge({
  name: "market_deposit_yield_bps",
  help: "Rendimiento actual del yacimiento sobre el output nominal (10000 = 100%)",
  labelNames: ["product", "product_id"] as const,
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null) return;
    this.reset();
    for (const d of s.deposits) {
      this.set({ product: d.productName, product_id: d.productId }, d.yieldBps);
    }
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

// ---------------------------------------------------------------------------
// Flujo circular de ingreso de ciudades (ADR-020).
//
// El capital y el nº de ciudades NO necesitan gauges propios: el rol `city`
// cuenta como rol de mercado, así que ya salen en
// market_total_capital_cents{role="city"} y market_active_agents{role="city"}.
// Ese primero es LA métrica de salud del modelo: si cae de forma sostenida, la
// demanda se está drenando y la economía va camino de apagarse.
// ---------------------------------------------------------------------------

new Gauge({
  name: "market_city_income_pending_cents",
  help: "Ingreso de ciudades debitado al pagador y aún no repartido, por fuente (dinero en tránsito)",
  labelNames: ["source"] as const,
  registers: [register],
  async collect() {
    const s = await fetchSnapshot();
    if (s === null) return;
    this.reset();
    // Emitir siempre ambas series (0 incluido): que `tax` desaparezca del
    // gráfico y que valga 0 son cosas distintas al diagnosticar.
    const bySource = new Map(s.cityIncomePending.map((r) => [r.source, r.cents]));
    for (const source of ["wage", "tax"]) {
      this.set({ source }, bySource.get(source) ?? 0);
    }
  },
});

/** No exporta nada: el import ejecuta el registro de gauges (side-effect). */
export const businessMetricsRegistered = true;
