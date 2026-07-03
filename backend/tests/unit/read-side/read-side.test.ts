/**
 * Tests unitarios PUROS de [M6 read-side]: schemas Zod y mappers de DTO.
 * Sin DB (los módulos de db se importan pero no abren conexiones al cargar).
 */
import { describe, expect, test } from "bun:test";

import { config } from "../../../src/config";
import {
  catalogController,
  recipeDurationRealSeconds,
  toProductDto,
  toRecipeDto,
} from "../../../src/controllers/catalog-controller";
import { toEventDto } from "../../../src/controllers/history-controller";
import { toTradeDto } from "../../../src/controllers/market-controller";
import {
  HistoryEventsQuerySchema,
  HistoryTradesQuerySchema,
} from "../../../src/schemas/history";
import { MarketTradesQuerySchema } from "../../../src/schemas/market";

const UUID_A = "01890000-0000-7000-8000-000000000001";
const UUID_B = "01890000-0000-7000-8000-000000000002";
const UUID_C = "01890000-0000-7000-8000-000000000003";
const UUID_D = "01890000-0000-7000-8000-000000000004";
const UUID_E = "01890000-0000-7000-8000-000000000005";
const UUID_F = "01890000-0000-7000-8000-000000000006";

describe("MarketTradesQuerySchema", () => {
  test("limit default 100 y clamp silencioso a [1, 1000]", () => {
    expect(MarketTradesQuerySchema.parse({}).limit).toBe(100);
    expect(MarketTradesQuerySchema.parse({ limit: "5000" }).limit).toBe(1000);
    expect(MarketTradesQuerySchema.parse({ limit: "0" }).limit).toBe(1);
    expect(MarketTradesQuerySchema.parse({ limit: "no-numerico" }).limit).toBe(100);
  });

  test("since se coacciona a Date", () => {
    const parsed = MarketTradesQuerySchema.parse({ since: "2026-07-01T00:00:00Z" });
    expect(parsed.since).toBeInstanceOf(Date);
    expect(parsed.since?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(MarketTradesQuerySchema.parse({}).since).toBeUndefined();
  });
});

describe("HistoryTradesQuerySchema", () => {
  test("limit default 200, max 1000 (openapi /history/*)", () => {
    expect(HistoryTradesQuerySchema.parse({}).limit).toBe(200);
    expect(HistoryTradesQuerySchema.parse({ limit: "9999" }).limit).toBe(1000);
  });

  test("side solo acepta buyer|seller", () => {
    expect(HistoryTradesQuerySchema.parse({ side: "buyer" }).side).toBe("buyer");
    expect(() => HistoryTradesQuerySchema.parse({ side: "comprador" })).toThrow();
  });
});

describe("HistoryEventsQuerySchema", () => {
  test("event_type único (string) se normaliza a array", () => {
    const parsed = HistoryEventsQuerySchema.parse({ event_type: "order_placed" });
    expect(parsed.event_type).toEqual(["order_placed"]);
  });

  test("event_type array pasa tal cual; ausente queda undefined", () => {
    const parsed = HistoryEventsQuerySchema.parse({
      event_type: ["trade_executed", "order_expired"],
    });
    expect(parsed.event_type).toEqual(["trade_executed", "order_expired"]);
    expect(HistoryEventsQuerySchema.parse({}).event_type).toBeUndefined();
  });

  test("event_type inválido ⇒ error de validación (400)", () => {
    expect(() => HistoryEventsQuerySchema.parse({ event_type: "no_existe" })).toThrow();
  });
});

describe("recipeDurationRealSeconds (openapi: duration_seconds en s REALES)", () => {
  test("convierte el INTERVAL simulado con el factor de simulación", () => {
    // germinado_rapido: 60 s simulados → 60/factor s reales (12 con factor 5).
    const expected = Math.max(1, Math.round(60 / config.simTimeFactor));
    expect(recipeDurationRealSeconds("00:01:00")).toBe(expected);
  });

  test("1 hora simulada", () => {
    const expected = Math.max(1, Math.round(3600 / config.simTimeFactor));
    expect(recipeDurationRealSeconds("01:00:00")).toBe(expected);
    expect(recipeDurationRealSeconds("1 hour")).toBe(expected);
  });

  test("piso 1 (openapi minimum 1)", () => {
    expect(recipeDurationRealSeconds("00:00:01")).toBeGreaterThanOrEqual(1);
  });
});

describe("mappers de DTO (snake_case, fechas ISO)", () => {
  test("toProductDto", () => {
    const createdAt = new Date("2026-07-01T10:00:00.000Z");
    expect(
      toProductDto({
        productId: UUID_A,
        name: "Trigo",
        unit: "kg",
        category: "raw_primary",
        createdAt,
      }),
    ).toEqual({
      product_id: UUID_A,
      name: "Trigo",
      unit: "kg",
      category: "raw_primary",
      created_at: "2026-07-01T10:00:00.000Z",
    });
  });

  test("toRecipeDto expone output_qty_cent/qty_required_cent y duration_seconds", () => {
    const createdAt = new Date("2026-07-01T10:00:00.000Z");
    const dto = toRecipeDto({
      recipeId: UUID_B,
      outputProductId: UUID_A,
      outputQty: 50_000,
      duration: "00:01:00",
      wageRateCentsPerSec: 1,
      name: "Germinado rápido",
      createdAt,
      inputs: [{ recipeId: UUID_B, productId: UUID_C, qtyRequired: 150 }],
    });
    expect(dto).toEqual({
      recipe_id: UUID_B,
      name: "Germinado rápido",
      output_product_id: UUID_A,
      output_qty_cent: 50_000,
      duration_seconds: Math.max(1, Math.round(60 / config.simTimeFactor)),
      wage_rate_cents_per_sec: 1,
      inputs: [{ product_id: UUID_C, qty_required_cent: 150 }],
      created_at: "2026-07-01T10:00:00.000Z",
    });
  });

  test("toTradeDto expone qty_executed_cent y executed_at ISO", () => {
    const executedAt = new Date("2026-07-02T12:34:56.789Z");
    expect(
      toTradeDto({
        tradeId: UUID_A,
        buyOrderId: UUID_B,
        sellOrderId: UUID_C,
        buyerAgentId: UUID_D,
        sellerAgentId: UUID_E,
        productId: UUID_F,
        qtyExecuted: 250,
        priceCents: 120,
        feeBuyerCents: 5,
        feeSellerCents: 5,
        executedAt,
      }),
    ).toEqual({
      trade_id: UUID_A,
      buy_order_id: UUID_B,
      sell_order_id: UUID_C,
      buyer_agent_id: UUID_D,
      seller_agent_id: UUID_E,
      product_id: UUID_F,
      qty_executed_cent: 250,
      price_cents: 120,
      fee_buyer_cents: 5,
      fee_seller_cents: 5,
      executed_at: "2026-07-02T12:34:56.789Z",
    });
  });

  test("toEventDto conserva agent_id null (eventos sistémicos)", () => {
    const occurredAt = new Date("2026-07-03T00:00:00.000Z");
    expect(
      toEventDto({
        eventId: UUID_A,
        eventType: "snapshot_taken",
        agentId: null,
        payload: { snapshot_id: UUID_B, note: "manual" },
        occurredAt,
      }),
    ).toEqual({
      event_id: UUID_A,
      event_type: "snapshot_taken",
      agent_id: null,
      occurred_at: "2026-07-03T00:00:00.000Z",
      payload: { snapshot_id: UUID_B, note: "manual" },
    });
  });

  test("catalogController expone los cuatro handlers de lectura", () => {
    expect(typeof catalogController.listProducts).toBe("function");
    expect(typeof catalogController.getProduct).toBe("function");
    expect(typeof catalogController.listRecipes).toBe("function");
    expect(typeof catalogController.getRecipe).toBe("function");
  });
});
