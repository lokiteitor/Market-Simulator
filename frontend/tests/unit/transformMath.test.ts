/**
 * transformMath.test.ts — helpers puros de transformaciones: salario upfront,
 * requisitos de insumos y rendimiento de yacimientos (ADR-023).
 */
import { describe, expect, test } from "bun:test";

import type {
  Deposit,
  InventoryPosition,
  Recipe,
} from "../../src/api/types";
import {
  depositForRecipe,
  effectiveOutputCent,
  estimateWageCents,
  inputRequirements,
} from "../../src/pages/transformations/transformMath";

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    recipe_id: "r1",
    name: "Minería de carbón",
    output_product_id: "p-carbon",
    output_qty_cent: 5000,
    duration_seconds: 720, // 1h simulada con factor 5×
    wage_rate_cents_per_sec: 2,
    installation_type_id: "it1",
    inputs: [],
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeDeposit(overrides: Partial<Deposit> = {}): Deposit {
  return {
    product_id: "p-carbon",
    product_key: "carbon",
    qty_initial_cent: 1_000_000,
    qty_remaining_cent: 625_000,
    yield_bps: 6250,
    ...overrides,
  };
}

describe("effectiveOutputCent", () => {
  test("rendimiento pleno (10000 bps) devuelve la salida nominal", () => {
    expect(effectiveOutputCent(5000, 3, 10_000)).toBe(15_000);
  });

  test("yacimiento agotado (0 bps) no produce nada", () => {
    expect(effectiveOutputCent(5000, 3, 0)).toBe(0);
  });

  test("aplica floor con rendimientos intermedios", () => {
    // floor(5000 × 1 × 3333 / 10000) = floor(1666.5) = 1666
    expect(effectiveOutputCent(5000, 1, 3333)).toBe(1666);
  });

  test("suelo de rendimiento (2500 bps por defecto)", () => {
    expect(effectiveOutputCent(5000, 2, 2500)).toBe(2500);
  });

  test("sin pérdida de precisión con magnitudes grandes (BigInt)", () => {
    expect(effectiveOutputCent(1_000_000_000, 1000, 9999)).toBe(
      999_900_000_000,
    );
  });
});

describe("depositForRecipe", () => {
  const deposits = [makeDeposit(), makeDeposit({ product_id: "p-gas", product_key: "gas_natural" })];

  test("encuentra el yacimiento del producto de salida", () => {
    expect(depositForRecipe(makeRecipe(), deposits)?.product_key).toBe(
      "carbon",
    );
  });

  test("producto sin yacimiento (inagotable) → null", () => {
    const recipe = makeRecipe({ output_product_id: "p-trigo" });
    expect(depositForRecipe(recipe, deposits)).toBeNull();
    expect(depositForRecipe(recipe, [])).toBeNull();
  });
});

describe("estimateWageCents", () => {
  test("rate × duración simulada (real × factor) × ejecuciones", () => {
    // 720 s reales × 5 = 3600 s sim; 2 ¢/s × 3600 × 2 ejecuciones = 14400 ¢
    expect(estimateWageCents(makeRecipe(), 2)).toBe(14_400);
  });
});

describe("inputRequirements", () => {
  const recipe = makeRecipe({
    inputs: [
      { product_id: "p-agua", qty_required_cent: 1000 },
      { product_id: "p-semilla", qty_required_cent: 250 },
    ],
  });
  const inventory: InventoryPosition[] = [
    { product_id: "p-agua", qty_available_cent: 2500, qty_reserved_cent: 0 },
  ];

  test("multiplica por ejecuciones y compara con el inventario", () => {
    const reqs = inputRequirements(recipe, 2, inventory);
    expect(reqs).toEqual([
      {
        productId: "p-agua",
        requiredCent: 2000,
        availableCent: 2500,
        ok: true,
      },
      {
        productId: "p-semilla",
        requiredCent: 500,
        availableCent: 0,
        ok: false,
      },
    ]);
  });

  test("receta primaria sin insumos → lista vacía", () => {
    expect(inputRequirements(makeRecipe(), 5, inventory)).toEqual([]);
  });
});
