/**
 * Tests unitarios PUROS de [M9 seed] — sin DB.
 *
 * Cubren las funciones puras exportadas por src/seed.ts:
 *   - parseSeedConfig (schema Zod + integridad referencial)
 *   - seedConfigHash (SHA-256 determinista)
 *   - buildAgentPlan (usernames {role}_{i}, capital determinista por rol)
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentRoleKey, SeedCapitalRange } from "../../../src/config";
import { randIntInclusive, rngFor } from "../../../src/lib/rng";
import {
  buildAgentPlan,
  parseSeedConfig,
  seedConfigHash,
  type SeedConfig,
} from "../../../src/seed";

const RANGES: Record<AgentRoleKey, SeedCapitalRange> = {
  primary_producer: { minCents: 50000, maxCents: 120000 },
  transformer: { minCents: 120000, maxCents: 250000 },
  consumer: { minCents: 80000, maxCents: 150000 },
  trader: { minCents: 200000, maxCents: 400000 },
};

function baseConfig(): SeedConfig {
  return {
    products: [
      { key: "trigo", name: "Trigo", unit: "kg", category: "raw_primary" },
      { key: "harina", name: "Harina", unit: "kg", category: "intermediate" },
      { key: "pan", name: "Pan", unit: "kg", category: "final_consumption" },
    ],
    recipes: [
      {
        key: "cultivo_trigo",
        name: "Cultivo de trigo",
        output: "trigo",
        output_qty_cent: 50000,
        duration_sim_seconds: 3600,
        wage_rate_cents_per_sec: 1,
        inputs: [],
      },
      {
        key: "molienda",
        name: "Molienda",
        output: "harina",
        output_qty_cent: 8000,
        duration_sim_seconds: 1800,
        wage_rate_cents_per_sec: 2,
        inputs: [{ product: "trigo", qty_cent: 10000 }],
      },
    ],
    roles: {
      primary_producer: {
        initial_agents: 2,
        capacities: [{ recipe: "cultivo_trigo", installations: 2 }],
      },
      transformer: {
        initial_agents: 1,
        capacities: [{ recipe: "molienda", installations: 1 }],
      },
      consumer: { initial_agents: 3, capacities: [] },
      trader: { initial_agents: 0, capacities: [] },
    },
  };
}

describe("parseSeedConfig", () => {
  test("acepta el infra/seed-config.json real del repo", async () => {
    const raw = await readFile(
      resolve(import.meta.dir, "../../../../infra/seed-config.json"),
      "utf8",
    );
    const cfg = parseSeedConfig(raw);
    expect(cfg.products.length).toBeGreaterThanOrEqual(7);
    expect(cfg.recipes.some((r) => r.key === "germinado_rapido")).toBe(true);
    // La receta rápida E2E: 60 s simulados, sin insumos.
    const rapida = cfg.recipes.find((r) => r.key === "germinado_rapido");
    expect(rapida?.duration_sim_seconds).toBe(60);
    expect(rapida?.inputs).toEqual([]);
  });

  test("acepta una config mínima válida (ignora claves extra como $comment)", () => {
    const raw = JSON.stringify({ $comment: "x", ...baseConfig() });
    const cfg = parseSeedConfig(raw);
    expect(cfg.products).toHaveLength(3);
    expect(cfg.recipes).toHaveLength(2);
  });

  test("rechaza JSON inválido", () => {
    expect(() => parseSeedConfig("{ nope")).toThrow(/JSON inválido/);
  });

  test("rechaza categoría de producto desconocida", () => {
    const cfg = baseConfig();
    (cfg.products[0] as { category: string }).category = "no_existe";
    expect(() => parseSeedConfig(JSON.stringify(cfg))).toThrow(
      /estructura inválida/,
    );
  });

  test("rechaza receta con output desconocido", () => {
    const cfg = baseConfig();
    cfg.recipes[0]!.output = "unobtainium";
    expect(() => parseSeedConfig(JSON.stringify(cfg))).toThrow(
      /produce un producto desconocido/,
    );
  });

  test("rechaza receta con insumo desconocido", () => {
    const cfg = baseConfig();
    cfg.recipes[1]!.inputs = [{ product: "unobtainium", qty_cent: 100 }];
    expect(() => parseSeedConfig(JSON.stringify(cfg))).toThrow(
      /consume un producto desconocido/,
    );
  });

  test("rechaza product key duplicada", () => {
    const cfg = baseConfig();
    cfg.products.push({
      key: "trigo",
      name: "Trigo 2",
      unit: "kg",
      category: "raw_primary",
    });
    expect(() => parseSeedConfig(JSON.stringify(cfg))).toThrow(
      /product key duplicada/,
    );
  });

  test("rechaza capacidad que referencia receta desconocida", () => {
    const cfg = baseConfig();
    cfg.roles.trader.capacities = [{ recipe: "no_existe", installations: 1 }];
    expect(() => parseSeedConfig(JSON.stringify(cfg))).toThrow(
      /receta desconocida/,
    );
  });

  test("rechaza roles incompletos", () => {
    const cfg: Record<string, unknown> = { ...baseConfig() };
    cfg.roles = { primary_producer: { initial_agents: 1, capacities: [] } };
    expect(() => parseSeedConfig(JSON.stringify(cfg))).toThrow(
      /estructura inválida/,
    );
  });
});

describe("seedConfigHash", () => {
  test("SHA-256 hex del contenido crudo (vector conocido)", () => {
    expect(seedConfigHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("determinista y sensible al contenido", () => {
    expect(seedConfigHash("x")).toBe(seedConfigHash("x"));
    expect(seedConfigHash("x")).not.toBe(seedConfigHash("y"));
  });
});

describe("buildAgentPlan", () => {
  const cfg = baseConfig();

  test("usernames {role}_{i} 1-based y conteo por initial_agents", () => {
    const plan = buildAgentPlan(cfg, { masterSeed: 42, capitalRanges: RANGES });
    expect(plan.map((e) => e.username)).toEqual([
      "primary_producer_1",
      "primary_producer_2",
      "transformer_1",
      "consumer_1",
      "consumer_2",
      "consumer_3",
    ]);
    expect(plan.filter((e) => e.role === "trader")).toHaveLength(0);
  });

  test("capital dentro del rango del rol", () => {
    const plan = buildAgentPlan(cfg, { masterSeed: 42, capitalRanges: RANGES });
    for (const entry of plan) {
      const range = RANGES[entry.role];
      expect(entry.capitalCents).toBeGreaterThanOrEqual(range.minCents);
      expect(entry.capitalCents).toBeLessThanOrEqual(range.maxCents);
      expect(Number.isSafeInteger(entry.capitalCents)).toBe(true);
    }
  });

  test("determinista: dos llamadas producen el mismo plan", () => {
    const a = buildAgentPlan(cfg, { masterSeed: 42, capitalRanges: RANGES });
    const b = buildAgentPlan(cfg, { masterSeed: 42, capitalRanges: RANGES });
    expect(a).toEqual(b);
  });

  test("capital derivado EXCLUSIVAMENTE de (masterSeed, username) — §13", () => {
    const plan = buildAgentPlan(cfg, { masterSeed: 42, capitalRanges: RANGES });
    for (const entry of plan) {
      const range = RANGES[entry.role];
      const expected = randIntInclusive(
        rngFor(42, entry.username),
        range.minCents,
        range.maxCents,
      );
      expect(entry.capitalCents).toBe(expected);
    }
  });

  test("otra semilla maestra cambia el plan", () => {
    const a = buildAgentPlan(cfg, { masterSeed: 42, capitalRanges: RANGES });
    const b = buildAgentPlan(cfg, { masterSeed: 43, capitalRanges: RANGES });
    expect(a.map((e) => e.capitalCents)).not.toEqual(
      b.map((e) => e.capitalCents),
    );
  });
});
