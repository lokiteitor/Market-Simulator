import { describe, expect, test } from "bun:test";

import type { MarketOrderRow, TradeRow } from "../../../src/db/schema";
import {
  ListOrdersQuerySchema,
  OrderIdParamsSchema,
  orderToApi,
  PlaceOrderBodySchema,
  PlaceOrderResponseSchema,
  tradeToApi,
} from "../../../src/schemas/orders";

const UUID_A = "01890b2e-59d1-7abc-8def-0123456789ab";
const UUID_B = "01890b2e-59d1-7abc-8def-0123456789ac";
const UUID_C = "01890b2e-59d1-7abc-8def-0123456789ad";

describe("PlaceOrderBodySchema", () => {
  const valid = {
    product_id: UUID_A,
    side: "buy",
    qty_cent: 1500,
    limit_price_cents: 250,
    ttl_seconds: 3600,
  };

  test("acepta un body válido (client_order_id opcional)", () => {
    expect(PlaceOrderBodySchema.parse(valid)).toEqual(valid as never);
    expect(
      PlaceOrderBodySchema.parse({ ...valid, client_order_id: "abc-123" }).client_order_id,
    ).toBe("abc-123");
  });

  test("rechaza qty/precio/ttl no positivos o no enteros", () => {
    expect(PlaceOrderBodySchema.safeParse({ ...valid, qty_cent: 0 }).success).toBe(false);
    expect(PlaceOrderBodySchema.safeParse({ ...valid, qty_cent: 1.5 }).success).toBe(false);
    expect(PlaceOrderBodySchema.safeParse({ ...valid, limit_price_cents: -1 }).success).toBe(false);
    expect(PlaceOrderBodySchema.safeParse({ ...valid, ttl_seconds: 0 }).success).toBe(false);
  });

  test("rechaza side inválido y product_id no-UUID", () => {
    expect(PlaceOrderBodySchema.safeParse({ ...valid, side: "hold" }).success).toBe(false);
    expect(PlaceOrderBodySchema.safeParse({ ...valid, product_id: "nope" }).success).toBe(false);
  });

  test("rechaza client_order_id de más de 64 chars", () => {
    expect(
      PlaceOrderBodySchema.safeParse({ ...valid, client_order_id: "x".repeat(65) }).success,
    ).toBe(false);
  });
});

describe("ListOrdersQuerySchema", () => {
  test("defaults: limit 100, sin filtros", () => {
    const q = ListOrdersQuerySchema.parse({});
    expect(q.limit).toBe(100);
    expect(q.status).toBeUndefined();
    expect(q.cursor).toBeUndefined();
  });

  test("status única (string) se normaliza a array; repetida se conserva", () => {
    expect(ListOrdersQuerySchema.parse({ status: "active" }).status).toEqual(["active"]);
    expect(ListOrdersQuerySchema.parse({ status: ["active", "completed"] }).status).toEqual([
      "active",
      "completed",
    ]);
  });

  test("status inválido rechaza", () => {
    expect(ListOrdersQuerySchema.safeParse({ status: "open" }).success).toBe(false);
  });

  test("limit: clamp silencioso a [1, 500] (§17)", () => {
    expect(ListOrdersQuerySchema.parse({ limit: "9999" }).limit).toBe(500);
    expect(ListOrdersQuerySchema.parse({ limit: "0" }).limit).toBe(1);
    expect(ListOrdersQuerySchema.parse({ limit: "250" }).limit).toBe(250);
  });

  test("since debe ser ISO date-time", () => {
    expect(ListOrdersQuerySchema.safeParse({ since: "2026-07-03T10:00:00Z" }).success).toBe(true);
    expect(ListOrdersQuerySchema.safeParse({ since: "2026-07-03T10:00:00+02:00" }).success).toBe(
      true,
    );
    expect(ListOrdersQuerySchema.safeParse({ since: "ayer" }).success).toBe(false);
  });
});

describe("OrderIdParamsSchema", () => {
  test("valida UUID", () => {
    expect(OrderIdParamsSchema.safeParse({ order_id: UUID_A }).success).toBe(true);
    expect(OrderIdParamsSchema.safeParse({ order_id: "123" }).success).toBe(false);
  });
});

describe("conversores fila → API (snake_case, timestamps ISO)", () => {
  const orderRow: MarketOrderRow = {
    orderId: UUID_A,
    agentId: UUID_B,
    productId: UUID_C,
    side: "sell",
    qtyOriginal: 500,
    qtyPending: 200,
    limitPriceCents: 900,
    status: "partial",
    createdAt: new Date("2026-07-03T10:00:00.000Z"),
    updatedAt: new Date("2026-07-03T10:05:00.000Z"),
    expiresAt: new Date("2026-07-03T11:00:00.000Z"),
  };

  const tradeRow: TradeRow = {
    tradeId: UUID_A,
    buyOrderId: UUID_B,
    sellOrderId: UUID_C,
    buyerAgentId: UUID_B,
    sellerAgentId: UUID_C,
    productId: UUID_A,
    qtyExecuted: 300,
    priceCents: 900,
    feeBuyerCents: 11,
    feeSellerCents: 11,
    executedAt: new Date("2026-07-03T10:05:00.000Z"),
  };

  test("orderToApi mapea todos los campos del openapi Order", () => {
    expect(orderToApi(orderRow)).toEqual({
      order_id: UUID_A,
      agent_id: UUID_B,
      product_id: UUID_C,
      side: "sell",
      qty_original_cent: 500,
      qty_pending_cent: 200,
      limit_price_cents: 900,
      status: "partial",
      created_at: "2026-07-03T10:00:00.000Z",
      updated_at: "2026-07-03T10:05:00.000Z",
      expires_at: "2026-07-03T11:00:00.000Z",
    });
  });

  test("tradeToApi mapea todos los campos del openapi Trade", () => {
    expect(tradeToApi(tradeRow)).toEqual({
      trade_id: UUID_A,
      buy_order_id: UUID_B,
      sell_order_id: UUID_C,
      buyer_agent_id: UUID_B,
      seller_agent_id: UUID_C,
      product_id: UUID_A,
      qty_executed_cent: 300,
      price_cents: 900,
      fee_buyer_cents: 11,
      fee_seller_cents: 11,
      executed_at: "2026-07-03T10:05:00.000Z",
    });
  });

  test("PlaceOrderResponse = Order + trades_generated valida contra el schema", () => {
    const body = { ...orderToApi(orderRow), trades_generated: [tradeToApi(tradeRow)] };
    expect(PlaceOrderResponseSchema.safeParse(body).success).toBe(true);
  });
});
