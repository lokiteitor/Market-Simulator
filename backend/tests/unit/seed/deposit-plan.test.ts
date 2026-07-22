/**
 * Plan determinista de yacimientos finitos (ADR-023) — sin DB.
 *
 * Lo que se fija aquí: el tamaño sale de (masterSeed, clave del producto) y de
 * nada más —igual que el capital semilla—, y la conversión ejecuciones→qty_cent
 * usa el output de la receta del recurso.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randIntInclusive, rngFor } from "../../../src/lib/rng";
import {
  buildDepositPlan,
  DEPOSIT_RNG_PREFIX,
  parseSeedConfig,
  type SeedConfig,
} from "../../../src/seed";

const OPTS = { masterSeed: 42, minExecutions: 28000, maxExecutions: 52000 };

function baseConfig(): SeedConfig {
  return {
    products: [
      { key: "carbon", name: "Carbón", unit: "kg", category: "raw_primary", finite: true },
      { key: "agua", name: "Agua", unit: "litro", category: "raw_primary" },
      { key: "acero", name: "Acero", unit: "kg", category: "intermediate" },
    ],
    recipes: [
      {
        key: "mineria_carbon",
        name: "Minería de carbón",
        output: "carbon",
        installation_type: "mina",
        output_qty_cent: 50000,
        duration_sim_seconds: 7200,
        wage_rate_cents_per_sec: 1,
        inputs: [{ product: "agua", qty_cent: 30000 }],
      },
      {
        key: "pozo_agua",
        name: "Pozo de agua",
        output: "agua",
        installation_type: "mina",
        output_qty_cent: 36000,
        duration_sim_seconds: 1800,
        wage_rate_cents_per_sec: 2,
        inputs: [],
      },
    ],
    installation_types: [
      {
        key: "mina",
        name: "Mina",
        role: "transformer",
        unit_label: "galerias",
        base_price_cents: 30000,
        growth_bps: 17000,
        max_level: 10,
        recipes: ["mineria_carbon", "pozo_agua"],
      },
    ],
    roles: {
      transformer: { initial_agents: 1 },
      trader: { initial_agents: 0 },
    },
  };
}

async function loadCatalog(): Promise<SeedConfig> {
  const raw = await readFile(resolve(import.meta.dir, "../../../../infra/seed-config.json"), "utf8");
  return parseSeedConfig(raw);
}

describe("buildDepositPlan", () => {
  test("solo planifica los productos marcados finite", () => {
    const plan = buildDepositPlan(baseConfig(), OPTS);
    expect(plan.map((e) => e.productKey)).toEqual(["carbon"]);
  });

  test("qty = ejecuciones sorteadas × output_qty_cent de su receta", () => {
    const [entry] = buildDepositPlan(baseConfig(), OPTS);
    expect(entry?.qtyInitialCent).toBe(entry!.executions * 50000);
  });

  test("ejecuciones dentro del rango configurado", () => {
    for (const entry of buildDepositPlan(baseConfig(), OPTS)) {
      expect(entry.executions).toBeGreaterThanOrEqual(OPTS.minExecutions);
      expect(entry.executions).toBeLessThanOrEqual(OPTS.maxExecutions);
    }
  });

  test("derivado EXCLUSIVAMENTE de (masterSeed, clave del producto)", () => {
    const [entry] = buildDepositPlan(baseConfig(), OPTS);
    const rng = rngFor(OPTS.masterSeed, `${DEPOSIT_RNG_PREFIX}carbon`);
    expect(entry?.executions).toBe(
      randIntInclusive(rng, OPTS.minExecutions, OPTS.maxExecutions),
    );
  });

  test("determinista: dos llamadas producen el mismo plan", () => {
    expect(buildDepositPlan(baseConfig(), OPTS)).toEqual(buildDepositPlan(baseConfig(), OPTS));
  });

  test("otra semilla maestra cambia el yacimiento", () => {
    const otro = buildDepositPlan(baseConfig(), { ...OPTS, masterSeed: 43 });
    expect(otro[0]?.executions).not.toBe(buildDepositPlan(baseConfig(), OPTS)[0]?.executions);
  });

  test("rango degenerado (min == max): tamaño exacto", () => {
    const plan = buildDepositPlan(baseConfig(), {
      ...OPTS,
      minExecutions: 1000,
      maxExecutions: 1000,
    });
    expect(plan[0]).toMatchObject({ executions: 1000, qtyInitialCent: 1000 * 50000 });
  });

  test("catálogo real: planifica los 15 recursos no renovables", async () => {
    const plan = buildDepositPlan(await loadCatalog(), OPTS);
    expect(plan.map((e) => e.productKey).sort()).toEqual(
      [
        "arcilla",
        "bauxita",
        "carbon",
        "caliza",
        "fosfato",
        "gas_natural",
        "hierro",
        "litio",
        "mineral_cobre",
        "niquel",
        "petroleo",
        "piedra",
        "plata",
        "sal",
        "uranio",
      ].sort(),
    );
  });
});
