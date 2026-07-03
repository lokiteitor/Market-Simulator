/**
 * Controller de `/agents/*` [M2 agents].
 *
 * Convierte entre el dominio (camelCase, Date) y el contrato HTTP del openapi
 * (snake_case, ISO 8601). La validación de entrada la hace Zod en las rutas
 * (fastify-type-provider-zod); aquí solo se castea el resultado ya validado.
 *
 * `request.agentId` lo setea el preHandler `app.authenticate` del plugin de
 * auth [M1] (module augmentation en src/auth/types.d.ts).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AgentRow, EventLogRow, InventoryLotRow, MarketOrderRow } from "../db/schema";
import type {
  AgentEventJson,
  AgentIdParams,
  AgentOrderJson,
  AgentProcessJson,
  AgentPublicJson,
  CapacityStatusJson,
  InventoryLotJson,
  InventoryLotsQuery,
  InventoryPositionJson,
  InventoryQuery,
  SelfStateQuery,
} from "../schemas/agents";
import {
  agentService,
  type CapacityStatusView,
  type InventoryPositionView,
  type RunningProcessView,
} from "../services/agent-service";

// ---------------------------------------------------------------------------
// Mapeos dominio → JSON (snake_case, openapi components)
// ---------------------------------------------------------------------------

function toAgentPublicJson(a: AgentRow): AgentPublicJson {
  return {
    agent_id: a.agentId,
    username: a.username,
    role: a.role,
    status: a.status,
    registered_at: a.registeredAt.toISOString(),
    bankrupt_at: a.bankruptAt === null ? null : a.bankruptAt.toISOString(),
  };
}

function toInventoryPositionJson(p: InventoryPositionView): InventoryPositionJson {
  return {
    product_id: p.productId,
    qty_available_cent: p.qtyAvailable,
    qty_reserved_cent: p.qtyReserved,
  };
}

function toInventoryLotJson(l: InventoryLotRow): InventoryLotJson {
  return {
    lot_id: l.lotId,
    product_id: l.productId,
    origin: l.origin,
    qty_original_cent: l.qtyOriginal,
    qty_available_cent: l.qtyAvailable,
    qty_reserved_cent: l.qtyReserved,
    unit_cost_cents: l.unitCostCents,
    acquired_at: l.acquiredAt.toISOString(),
    source_trade_id: l.sourceTradeId,
    source_process_id: l.sourceProcessId,
  };
}

function toCapacityStatusJson(c: CapacityStatusView): CapacityStatusJson {
  return {
    recipe_id: c.recipeId,
    installations: c.installations,
    running: c.running,
    available_slots: c.availableSlots,
  };
}

function toOrderJson(o: MarketOrderRow): AgentOrderJson {
  return {
    order_id: o.orderId,
    agent_id: o.agentId,
    product_id: o.productId,
    side: o.side,
    qty_original_cent: o.qtyOriginal,
    qty_pending_cent: o.qtyPending,
    limit_price_cents: o.limitPriceCents,
    status: o.status,
    created_at: o.createdAt.toISOString(),
    updated_at: o.updatedAt.toISOString(),
    expires_at: o.expiresAt.toISOString(),
  };
}

function toProcessJson(p: RunningProcessView): AgentProcessJson {
  return {
    process_id: p.processId,
    agent_id: p.agentId,
    recipe_id: p.recipeId,
    executions_planned: p.executionsPlanned,
    current_execution: p.currentExecution,
    status: p.status,
    wage_paid_cents: p.wagePaidCents,
    started_at: p.startedAt.toISOString(),
    expected_end_at: p.expectedEndAt.toISOString(),
    actual_end_at: p.actualEndAt === null ? null : p.actualEndAt.toISOString(),
  };
}

function toEventJson(e: EventLogRow): AgentEventJson {
  return {
    event_id: e.eventId,
    event_type: e.eventType,
    agent_id: e.agentId,
    occurred_at: e.occurredAt.toISOString(),
    payload: (e.payload ?? {}) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const agentController = {
  /** GET /agents/me — snapshot completo (openapi AgentSnapshot). */
  async getMe(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { events_limit: eventsLimit } = request.query as SelfStateQuery;
    const state = await agentService.getSelfState(request.agentId, eventsLimit);
    await reply.code(200).send({
      agent: toAgentPublicJson(state.agent),
      capital_available_cents: state.capitalAvailableCents,
      capital_reserved_cents: state.capitalReservedCents,
      inventory: state.inventory.map(toInventoryPositionJson),
      active_orders: state.activeOrders.map(toOrderJson),
      running_processes: state.runningProcesses.map(toProcessJson),
      capacities: state.capacities.map(toCapacityStatusJson),
      recent_events: state.recentEvents.map(toEventJson),
    });
  },

  /** GET /agents/me/capacities. */
  async getMyCapacities(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const capacities = await agentService.getCapacities(request.agentId);
    await reply.code(200).send(capacities.map(toCapacityStatusJson));
  },

  /** GET /agents/me/inventory — posiciones agregadas por producto. */
  async getMyInventory(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { product_id: productId } = request.query as InventoryQuery;
    const positions = await agentService.getInventory(request.agentId, productId);
    await reply.code(200).send(positions.map(toInventoryPositionJson));
  },

  /** GET /agents/me/inventory/lots — detalle FIFO por lote. */
  async getMyInventoryLots(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { product_id: productId, only_with_stock: onlyWithStock } =
      request.query as InventoryLotsQuery;
    const lots = await agentService.getInventoryLots(request.agentId, {
      ...(productId !== undefined ? { productId } : {}),
      onlyWithStock,
    });
    await reply.code(200).send(lots.map(toInventoryLotJson));
  },

  /** GET /agents/{agent_id} — información pública (openapi AgentPublic). */
  async getAgentPublic(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { agent_id: agentId } = request.params as AgentIdParams;
    const row = await agentService.getPublicAgent(agentId);
    await reply.code(200).send(toAgentPublicJson(row));
  },
};
