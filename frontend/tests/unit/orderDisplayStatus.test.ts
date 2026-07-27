import { describe, expect, test } from "bun:test";
import {
  isCancellable,
  ORDER_DISPLAY_STATUS_LABEL,
  orderDisplayStatus,
  reserveRelease,
} from "../../src/pages/orders/orderDisplayStatus";
import type { Order, OrderStatus } from "../../src/api/types";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const FUTURO = "2026-07-27T12:05:00.000Z";
const PASADO = "2026-07-27T11:59:55.000Z";

function order(overrides: Partial<Order>): Order {
  return {
    order_id: "ord-1",
    agent_id: "ag-1",
    product_id: "trigo",
    side: "buy",
    qty_original_cent: 1_000,
    qty_pending_cent: 1_000,
    limit_price_cents: 500,
    status: "active",
    created_at: "2026-07-27T11:00:00.000Z",
    updated_at: "2026-07-27T11:00:00.000Z",
    expires_at: FUTURO,
    ...overrides,
  };
}

describe("orderDisplayStatus", () => {
  test("activa con expiración futura → sin cambio", () => {
    expect(orderDisplayStatus(order({ expires_at: FUTURO }), NOW)).toBe("active");
  });

  test("activa ya vencida → expiring (el barrido aún no pasó)", () => {
    expect(orderDisplayStatus(order({ expires_at: PASADO }), NOW)).toBe(
      "expiring",
    );
  });

  test("parcial ya vencida → expiring", () => {
    expect(
      orderDisplayStatus(order({ status: "partial", expires_at: PASADO }), NOW),
    ).toBe("expiring");
  });

  test("justo en el instante de expiración ya cuenta como vencida", () => {
    expect(
      orderDisplayStatus(
        order({ expires_at: new Date(NOW).toISOString() }),
        NOW,
      ),
    ).toBe("expiring");
  });

  test("los estados terminales quedan intactos aunque expires_at haya pasado", () => {
    const terminales: OrderStatus[] = ["completed", "cancelled", "expired"];
    for (const status of terminales) {
      expect(
        orderDisplayStatus(order({ status, expires_at: PASADO }), NOW),
      ).toBe(status);
    }
  });

  test("fecha inválida NO marca vencimiento", () => {
    expect(orderDisplayStatus(order({ expires_at: "no-es-fecha" }), NOW)).toBe(
      "active",
    );
  });
});

describe("ORDER_DISPLAY_STATUS_LABEL", () => {
  test("cubre los estados del contrato más el derivado", () => {
    expect(ORDER_DISPLAY_STATUS_LABEL.active).toBe("Activa");
    expect(ORDER_DISPLAY_STATUS_LABEL.expired).toBe("Expirada");
    expect(ORDER_DISPLAY_STATUS_LABEL.expiring).toBe("Vencida");
  });
});

describe("isCancellable", () => {
  test("abiertas y vencidas sí; terminales no", () => {
    expect(isCancellable("active")).toBe(true);
    expect(isCancellable("partial")).toBe(true);
    expect(isCancellable("expiring")).toBe(true);
    expect(isCancellable("completed")).toBe(false);
    expect(isCancellable("cancelled")).toBe(false);
    expect(isCancellable("expired")).toBe(false);
  });
});

describe("reserveRelease", () => {
  test("compra → capital pendiente al precio límite", () => {
    // 10.00 unidades × $5.00 = $50.00
    expect(
      reserveRelease({
        side: "buy",
        qty_pending_cent: 1_000,
        limit_price_cents: 500,
      }),
    ).toEqual({ kind: "capital", cents: 5_000 });
  });

  test("compra → floor, como notionalCents del backend", () => {
    // 1.50 × $3.33 = 499.5 → 499
    expect(
      reserveRelease({
        side: "buy",
        qty_pending_cent: 150,
        limit_price_cents: 333,
      }),
    ).toEqual({ kind: "capital", cents: 499 });
  });

  test("venta → mercancía pendiente", () => {
    expect(
      reserveRelease({
        side: "sell",
        qty_pending_cent: 750,
        limit_price_cents: 500,
      }),
    ).toEqual({ kind: "goods", qtyCent: 750 });
  });

  test("orden sin pendiente → nada que liberar", () => {
    expect(
      reserveRelease({
        side: "buy",
        qty_pending_cent: 0,
        limit_price_cents: 500,
      }),
    ).toEqual({ kind: "capital", cents: 0 });
  });
});
