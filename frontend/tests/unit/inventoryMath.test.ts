import { describe, expect, test } from "bun:test";
import {
  estimateInventoryValueCents,
  groupLotsByProduct,
  inventoryTotals,
  lotValueCents,
} from "../../src/pages/inventory/inventoryMath";
import type { InventoryLot } from "../../src/api/types";

function lot(overrides: Partial<InventoryLot>): InventoryLot {
  return {
    lot_id: "lot-1",
    product_id: "trigo",
    origin: "production",
    qty_original_cent: 1_000,
    qty_available_cent: 1_000,
    qty_reserved_cent: 0,
    unit_cost_cents: 500,
    acquired_at: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("lotValueCents", () => {
  test("cantidad (centésimas) × coste (centavos) / 100", () => {
    // 10.00 unidades a $5.00 = $50.00
    expect(lotValueCents(lot({}))).toBe(5_000);
  });

  test("suma disponible + reservado", () => {
    expect(
      lotValueCents(lot({ qty_available_cent: 600, qty_reserved_cent: 400 })),
    ).toBe(5_000);
  });

  test("lote vacío vale 0", () => {
    expect(
      lotValueCents(lot({ qty_available_cent: 0, qty_reserved_cent: 0 })),
    ).toBe(0);
  });
});

describe("groupLotsByProduct", () => {
  const lots: InventoryLot[] = [
    lot({
      lot_id: "b",
      qty_available_cent: 500,
      unit_cost_cents: 700,
      acquired_at: "2026-07-02T10:00:00.000Z",
    }),
    lot({
      lot_id: "a",
      qty_available_cent: 1_000,
      qty_reserved_cent: 500,
      unit_cost_cents: 400,
      acquired_at: "2026-07-01T10:00:00.000Z",
    }),
    lot({
      lot_id: "c",
      product_id: "maiz",
      qty_available_cent: 200,
      unit_cost_cents: 300,
    }),
  ];

  test("agrupa por producto y suma cantidades", () => {
    const positions = groupLotsByProduct(lots);
    expect(positions).toHaveLength(2);

    const trigo = positions.find((p) => p.product_id === "trigo");
    expect(trigo?.qty_available_cent).toBe(1_500);
    expect(trigo?.qty_reserved_cent).toBe(500);
    expect(trigo?.qty_total_cent).toBe(2_000);
    // 15.00 × $4.00 (parte de "a": 10+5) + 5.00 × $7.00 = 6.000 + 3.500
    expect(trigo?.value_cents).toBe(9_500);
  });

  test("coste medio ponderado = valor ÷ cantidad", () => {
    const trigo = groupLotsByProduct(lots).find((p) => p.product_id === "trigo");
    // $95.00 sobre 20.00 unidades → $4.75/u
    expect(trigo?.avg_unit_cost_cents).toBe(475);
  });

  test("los lotes quedan en orden FIFO (acquired_at ascendente)", () => {
    const trigo = groupLotsByProduct(lots).find((p) => p.product_id === "trigo");
    expect(trigo?.lots.map((l) => l.lot_id)).toEqual(["a", "b"]);
  });

  test("las posiciones salen ordenadas por valor descendente", () => {
    expect(groupLotsByProduct(lots).map((p) => p.product_id)).toEqual([
      "trigo",
      "maiz",
    ]);
  });

  test("posición sin stock → coste medio 0 (sin división por cero)", () => {
    const [position] = groupLotsByProduct([
      lot({ qty_available_cent: 0, qty_reserved_cent: 0 }),
    ]);
    expect(position?.avg_unit_cost_cents).toBe(0);
    expect(position?.value_cents).toBe(0);
  });

  test("fecha inválida no rompe el orden: va al final", () => {
    const [position] = groupLotsByProduct([
      lot({ lot_id: "malo", acquired_at: "no-es-fecha" }),
      lot({ lot_id: "bueno", acquired_at: "2026-07-05T00:00:00.000Z" }),
    ]);
    expect(position?.lots.map((l) => l.lot_id)).toEqual(["bueno", "malo"]);
  });

  test("sin lotes → sin posiciones", () => {
    expect(groupLotsByProduct([])).toEqual([]);
  });
});

describe("inventoryTotals", () => {
  test("agrega valor, productos, lotes y % reservado", () => {
    const totals = inventoryTotals(
      groupLotsByProduct([
        lot({ qty_available_cent: 1_000, qty_reserved_cent: 1_000 }),
        lot({ lot_id: "otro", product_id: "maiz", qty_available_cent: 2_000 }),
      ]),
    );
    expect(totals.product_count).toBe(2);
    expect(totals.lot_count).toBe(2);
    // 10.00 reservadas de 40.00 totales → 25%
    expect(totals.reserved_bps).toBe(2_500);
    // trigo: 20.00 × $5.00 = $100.00; maiz: 20.00 × $5.00 = $100.00
    expect(totals.value_cents).toBe(20_000);
  });

  test("inventario vacío → todo a cero", () => {
    expect(inventoryTotals([])).toEqual({
      value_cents: 0,
      product_count: 0,
      lot_count: 0,
      reserved_bps: 0,
    });
  });
});

describe("estimateInventoryValueCents", () => {
  test("suma el valor de todos los lotes", () => {
    expect(
      estimateInventoryValueCents([
        lot({}),
        lot({ lot_id: "otro", qty_available_cent: 250, unit_cost_cents: 200 }),
      ]),
    ).toBe(5_500);
  });

  test("sin lotes → 0", () => {
    expect(estimateInventoryValueCents([])).toBe(0);
  });
});
