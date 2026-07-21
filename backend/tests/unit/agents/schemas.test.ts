/**
 * Tests unitarios PUROS de src/schemas/agents.ts [M2 agents] — sin DB.
 * (Los services de M2 dependen de módulos paralelos M1/M4/M5 y de DB, por lo
 * que no se testean aquí; ver tests/e2e [M11].)
 */
import { describe, expect, test } from "bun:test";
import {
  AgentIdParamsSchema,
  AgentPublicSchema,
  AgentSnapshotSchema,
  InventoryLotsQuerySchema,
  InventoryQuerySchema,
  SelfStateQuerySchema,
} from "../../../src/schemas/agents";

const UUID = "0198c5f2-1111-7abc-8def-0123456789ab";

describe("SelfStateQuerySchema (GET /agents/me)", () => {
  test("aplica el default de events_limit (RECONNECT_EVENTS_LIMIT=100)", () => {
    expect(SelfStateQuerySchema.parse({})).toEqual({ events_limit: 100 });
  });

  test("coerciona strings numéricos del querystring", () => {
    expect(SelfStateQuerySchema.parse({ events_limit: "25" })).toEqual({ events_limit: 25 });
  });

  test("acepta 0 (sin eventos) y el máximo 1000", () => {
    expect(SelfStateQuerySchema.parse({ events_limit: "0" }).events_limit).toBe(0);
    expect(SelfStateQuerySchema.parse({ events_limit: "1000" }).events_limit).toBe(1000);
  });

  test("rechaza fuera de rango [0, 1000] y no enteros", () => {
    expect(SelfStateQuerySchema.safeParse({ events_limit: "-1" }).success).toBe(false);
    expect(SelfStateQuerySchema.safeParse({ events_limit: "1001" }).success).toBe(false);
    expect(SelfStateQuerySchema.safeParse({ events_limit: "1.5" }).success).toBe(false);
  });
});

describe("InventoryLotsQuerySchema (GET /agents/me/inventory/lots)", () => {
  test("only_with_stock default = true", () => {
    expect(InventoryLotsQuerySchema.parse({}).only_with_stock).toBe(true);
  });

  test('parsea "false"/"true" del querystring como booleanos', () => {
    expect(InventoryLotsQuerySchema.parse({ only_with_stock: "false" }).only_with_stock).toBe(
      false,
    );
    expect(InventoryLotsQuerySchema.parse({ only_with_stock: "true" }).only_with_stock).toBe(true);
  });

  test("product_id opcional debe ser UUID", () => {
    expect(InventoryLotsQuerySchema.parse({ product_id: UUID }).product_id).toBe(UUID);
    expect(InventoryLotsQuerySchema.safeParse({ product_id: "nope" }).success).toBe(false);
  });
});

describe("InventoryQuerySchema y AgentIdParamsSchema", () => {
  test("product_id opcional / agent_id obligatorio (UUID)", () => {
    expect(InventoryQuerySchema.parse({})).toEqual({});
    expect(AgentIdParamsSchema.parse({ agent_id: UUID }).agent_id).toBe(UUID);
    expect(AgentIdParamsSchema.safeParse({}).success).toBe(false);
  });
});

describe("Schemas de respuesta (shapes del openapi)", () => {
  const agentPublic = {
    agent_id: UUID,
    username: "transformer_1",
    role: "transformer",
    status: "active",
    registered_at: "2026-07-03T10:00:00.000Z",
    bankrupt_at: null,
  };

  test("AgentPublicSchema acepta el shape del openapi (bankrupt_at nullable)", () => {
    expect(AgentPublicSchema.parse(agentPublic)).toEqual(agentPublic as never);
    expect(
      AgentPublicSchema.safeParse({ ...agentPublic, role: "banker" }).success,
    ).toBe(false);
  });

  test("AgentSnapshotSchema acepta un snapshot completo", () => {
    const snapshot = {
      agent: agentPublic,
      capital_available_cents: 100000,
      capital_reserved_cents: 0,
      inventory: [{ product_id: UUID, qty_available_cent: 150, qty_reserved_cent: 0 }],
      active_orders: [
        {
          order_id: UUID,
          agent_id: UUID,
          product_id: UUID,
          side: "sell",
          qty_original_cent: 1000,
          qty_pending_cent: 400,
          limit_price_cents: 250,
          status: "partial",
          created_at: "2026-07-03T10:00:00.000Z",
          updated_at: "2026-07-03T10:05:00.000Z",
          expires_at: "2026-07-03T11:00:00.000Z",
        },
      ],
      running_processes: [
        {
          process_id: UUID,
          agent_id: UUID,
          recipe_id: UUID,
          executions_planned: 3,
          current_execution: 2,
          status: "running",
          wage_paid_cents: 180,
          started_at: "2026-07-03T10:00:00.000Z",
          expected_end_at: "2026-07-03T10:36:00.000Z",
          actual_end_at: null,
        },
      ],
      installations: [
        {
          installation_type: "campo",
          name: "Campo agrícola",
          unit_label: "hectareas",
          level: 2,
          running: 1,
          available_slots: 1,
          next_upgrade_price_cents: 25500,
        },
      ],
      recent_events: [
        {
          event_id: UUID,
          event_type: "trade_executed",
          agent_id: null,
          occurred_at: "2026-07-03T10:10:00.000Z",
          payload: { trade_id: UUID, qty_cent: 100 },
        },
      ],
    };
    const parsed = AgentSnapshotSchema.parse(snapshot);
    expect(parsed.active_orders).toHaveLength(1);
    expect(parsed.recent_events[0]?.payload).toEqual({ trade_id: UUID, qty_cent: 100 });
  });

  test("AgentSnapshotSchema rechaza capital negativo", () => {
    expect(
      AgentSnapshotSchema.safeParse({
        agent: agentPublic,
        capital_available_cents: -1,
        capital_reserved_cents: 0,
        inventory: [],
        active_orders: [],
        running_processes: [],
        installations: [],
        recent_events: [],
      }).success,
    ).toBe(false);
  });
});
