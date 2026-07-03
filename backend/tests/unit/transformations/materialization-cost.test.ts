/**
 * Tests puros del costeo de materialización (contrato §10.8) — [M4].
 *
 * unit_cost del lote producido =
 *   unitCostFromTotal(Σ(consumos qty×unit_cost)/100 + wage_paid_cents, qtyProducida)
 * con floor ÚNICO sobre la suma exacta de insumos (BigInt).
 */
import { describe, expect, test } from "bun:test";
import { unitCostFromTotal } from "../../../src/lib/money";
import {
  inputsTotalCostCents,
  qtyTimesExecutions,
} from "../../../src/services/transformation-service";

describe("inputsTotalCostCents", () => {
  test("sin insumos (receta primaria) ⇒ 0", () => {
    expect(inputsTotalCostCents([])).toBe(0);
  });

  test("un lote: 1.5 unidades (150 cent) a 200 c/unidad = 300", () => {
    expect(inputsTotalCostCents([{ qtyConsumed: 150, unitCostCents: 200 }])).toBe(300);
  });

  test("floor único sobre la suma (no por fila)", () => {
    // 50×3 = 150 y 51×3 = 153 ⇒ suma 303 ⇒ floor(303/100) = 3
    // (floor por fila daría 1 + 1 = 2).
    const rows = [
      { qtyConsumed: 50, unitCostCents: 3 },
      { qtyConsumed: 51, unitCostCents: 3 },
    ];
    expect(inputsTotalCostCents(rows)).toBe(3);
  });

  test("suma exacta con valores grandes (BigInt)", () => {
    const rows = [
      { qtyConsumed: 90_000_000, unitCostCents: 1_000_000 },
      { qtyConsumed: 1, unitCostCents: 1 },
    ];
    // (90e6 × 1e6 + 1) / 100 = 900_000_000_000.01 ⇒ floor
    expect(inputsTotalCostCents(rows)).toBe(900_000_000_000);
  });

  test("valores no enteros lanzan", () => {
    expect(() => inputsTotalCostCents([{ qtyConsumed: 1.5, unitCostCents: 10 }])).toThrow();
  });
});

describe("qtyTimesExecutions", () => {
  test("output_qty × executions: 50000 × 3 = 150000", () => {
    expect(qtyTimesExecutions(50_000, 3)).toBe(150_000);
  });

  test("producto fuera de rango seguro lanza", () => {
    expect(() => qtyTimesExecutions(Number.MAX_SAFE_INTEGER, 2)).toThrow();
  });
});

describe("unit_cost del lote producido (§10.8, composición)", () => {
  test("insumos 1000 + salario 500 sobre 500 unidades (50000 cent) ⇒ 3 c/unidad", () => {
    const totalCost =
      inputsTotalCostCents([{ qtyConsumed: 50_000, unitCostCents: 2 }]) + 500; // 1000 + 500
    const qtyProduced = qtyTimesExecutions(50_000, 1);
    expect(unitCostFromTotal(totalCost, qtyProduced)).toBe(3);
  });

  test("receta primaria (sin insumos): solo salario, floor", () => {
    // salario 60 sobre 500 kg (50000 cent) ⇒ floor(60×100/50000) = 0 c/unidad
    const totalCost = inputsTotalCostCents([]) + 60;
    expect(unitCostFromTotal(totalCost, 50_000)).toBe(0);
  });
});
