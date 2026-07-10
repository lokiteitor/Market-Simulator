/**
 * Controller del panel admin: vistas camelCase del service → DTOs snake_case.
 */
import type {
  AdminAgentsPageDto,
  AdminMarketProductDto,
  AdminOverviewDto,
  AdminProductionDto,
  AdminSnapshotPointDto,
} from "../schemas/admin";
import { adminService } from "../services/admin-service";

export const adminController = {
  async getOverview(): Promise<AdminOverviewDto> {
    const o = await adminService.getOverview();
    return {
      kpis: {
        active_agents: o.kpis.activeAgents,
        bankrupt_agents: o.kpis.bankruptAgents,
        total_capital_cents: o.kpis.totalCapitalCents,
        fees_collected_cents: o.kpis.feesCollectedCents,
        active_processes: o.kpis.activeProcesses,
        open_orders: o.kpis.openOrders,
        trade_volume_24h: o.kpis.tradeVolume24h,
        trades_24h: o.kpis.trades24h,
      },
      by_role: o.byRole.map((r) => ({
        role: r.role,
        active_agents: r.activeAgents,
        bankrupt_agents: r.bankruptAgents,
        total_capital_cents: r.totalCapitalCents,
      })),
    };
  },

  async listAgents(q: {
    limit: number;
    offset: number;
    role?: string;
    status?: "active" | "bankrupt";
  }): Promise<AdminAgentsPageDto> {
    const page = await adminService.listAgents(q);
    return {
      items: page.rows.map((a) => ({
        agent_id: a.agentId,
        username: a.username,
        role: a.role,
        status: a.status,
        capital_available_cents: a.capitalAvailableCents,
        capital_reserved_cents: a.capitalReservedCents,
        registered_at: a.registeredAt.toISOString(),
      })),
      total: page.total,
      limit: q.limit,
      offset: q.offset,
    };
  },

  async getMarket(): Promise<AdminMarketProductDto[]> {
    const rows = await adminService.getMarket();
    return rows.map((p) => ({
      product_id: p.productId,
      name: p.name,
      unit: p.unit,
      category: p.category,
      best_bid_cents: p.bestBidCents,
      best_ask_cents: p.bestAskCents,
      bid_depth: p.bidDepth,
      ask_depth: p.askDepth,
      total_inventory: p.totalInventory,
      trade_volume_24h: p.tradeVolume24h,
      vwap_24h_cents: p.vwap24hCents,
      trades_24h: p.trades24h,
    }));
  },

  async getProduction(): Promise<AdminProductionDto> {
    const prod = await adminService.getProduction();
    return {
      recipes: prod.recipes.map((r) => ({
        recipe_id: r.recipeId,
        recipe_name: r.recipeName,
        output_product_id: r.outputProductId,
        output_product_name: r.outputProductName,
        active_processes: r.activeProcesses,
        planned_executions: r.plannedExecutions,
        wage_paid_cents: r.wagePaidCents,
      })),
      produced: prod.produced.map((p) => ({
        product_id: p.productId,
        name: p.name,
        unit: p.unit,
        produced_units_24h: p.producedUnits24h,
      })),
    };
  },

  async getSnapshots(q: { limit: number }): Promise<AdminSnapshotPointDto[]> {
    const points = await adminService.getSnapshots(q);
    return points.map((s) => ({
      snapshot_id: s.snapshotId,
      taken_at: s.takenAt.toISOString(),
      active_agents: s.activeAgents,
      total_money_cents: s.totalMoneyCents,
      fees_collected_cents: s.feesCollectedCents,
    }));
  },
};
