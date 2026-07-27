/**
 * Service de administración/monitoreo (panel admin) — lecturas agregadas del
 * estado global del mercado, agentes/bots y volúmenes productivos.
 *
 * Solo-lectura: cada método abre una transacción (contrato §0: las tx se abren
 * en services) y delega en `monitoringRepository`. Los agregados que combinan
 * varias sentencias (overview, market) usan REPEATABLE READ para una foto MVCC
 * consistente, igual que snapshot-runner.
 */
import { withTransaction } from "../db";
import { incomeLedgerRepository } from "../repositories/income-ledger-repository";
import {
  monitoringRepository,
  type AgentsByRoleView,
  type AgentsPage,
  type CityListItemView,
  type MarketProductView,
  type OverviewView,
  type ProductionView,
  type SnapshotPointView,
} from "../repositories/monitoring-repository";

/** Cabecera del panel: KPIs + desglose por rol, en una sola foto consistente. */
export interface AdminOverview {
  kpis: OverviewView;
  byRole: AgentsByRoleView[];
}

/** Panel de ciudades (ADR-020/025): listado + agregados del flujo circular. */
export interface AdminCities {
  cities: CityListItemView[];
  pendingBySource: Array<{ source: string; cents: number }>;
  distributed: { totalCents: number; sweeps: number };
}

export const adminService = {
  async getOverview(): Promise<AdminOverview> {
    return withTransaction(
      async (tx) => {
        const kpis = await monitoringRepository.overview(tx);
        const byRole = await monitoringRepository.agentsByRole(tx);
        return { kpis, byRole };
      },
      { isolationLevel: "repeatable read" },
    );
  },

  async listAgents(opts: {
    limit: number;
    offset: number;
    role?: string;
    status?: "active" | "bankrupt";
  }): Promise<AgentsPage> {
    return withTransaction((tx) => monitoringRepository.listAgents(tx, opts));
  },

  async getCities(): Promise<AdminCities> {
    // Foto consistente: capitales, pendiente y repartido deben ser coherentes
    // entre sí (conservación monetaria, ADR-020).
    return withTransaction(
      async (tx) => {
        const cities = await monitoringRepository.listCities(tx);
        const pendingBySource = await incomeLedgerRepository.sumUnmaterializedBySource(tx);
        const distributed = await monitoringRepository.distributedIncome24h(tx);
        return { cities, pendingBySource, distributed };
      },
      { isolationLevel: "repeatable read" },
    );
  },

  async getMarket(): Promise<MarketProductView[]> {
    return withTransaction((tx) => monitoringRepository.marketByProduct(tx), {
      isolationLevel: "repeatable read",
    });
  },

  async getProduction(): Promise<ProductionView> {
    return withTransaction((tx) => monitoringRepository.production(tx), {
      isolationLevel: "repeatable read",
    });
  },

  async getSnapshots(opts: { limit: number }): Promise<SnapshotPointView[]> {
    const points = await withTransaction((tx) =>
      monitoringRepository.snapshotSeries(tx, opts),
    );
    // El repo los devuelve de más reciente a más antiguo; para graficar
    // cronológicamente se invierten aquí.
    return points.reverse();
  },
};
