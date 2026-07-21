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
  buildGoldPlan,
  GOLD_DEPOSIT_RNG_KEY,
  parseSeedConfig,
  seedConfigHash,
  type SeedConfig,
} from "../../../src/seed";

const RANGES: Record<AgentRoleKey, SeedCapitalRange> = {
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
        installation_type: "campo",
        output_qty_cent: 50000,
        duration_sim_seconds: 3600,
        wage_rate_cents_per_sec: 1,
        inputs: [],
      },
      {
        key: "molienda",
        name: "Molienda",
        output: "harina",
        installation_type: "molino",
        output_qty_cent: 8000,
        duration_sim_seconds: 1800,
        wage_rate_cents_per_sec: 2,
        inputs: [{ product: "trigo", qty_cent: 10000 }],
      },
    ],
    installation_types: [
      {
        key: "campo",
        name: "Campo agrícola",
        role: "transformer",
        unit_label: "hectareas",
        base_price_cents: 15000,
        growth_bps: 17000,
        max_level: 10,
        recipes: ["cultivo_trigo"],
      },
      {
        key: "molino",
        name: "Molino",
        role: "transformer",
        unit_label: "lineas_produccion",
        base_price_cents: 40000,
        growth_bps: 17000,
        max_level: 10,
        recipes: ["molienda"],
      },
    ],
    roles: {
      transformer: { initial_agents: 3 },
      consumer: { initial_agents: 3 },
      trader: { initial_agents: 0 },
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
    expect(cfg.recipes.some((r) => r.key === "pozo_somero")).toBe(true);
    // La receta rápida E2E: 60 s simulados, sin insumos.
    const rapida = cfg.recipes.find((r) => r.key === "pozo_somero");
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

  test("rechaza installation_type que referencia receta desconocida", () => {
    const cfg = baseConfig();
    cfg.installation_types[0]!.recipes = ["no_existe"];
    expect(() => parseSeedConfig(JSON.stringify(cfg))).toThrow(
      /receta desconocida/,
    );
  });

  test("rechaza receta cuyo installation_type no coincide con el tipo que la lista", () => {
    const cfg = baseConfig();
    cfg.recipes[0]!.installation_type = "molino";
    expect(() => parseSeedConfig(JSON.stringify(cfg))).toThrow(
      /declara tipo "molino" pero está listada en "campo"/,
    );
  });

  test("rechaza roles incompletos", () => {
    const cfg: Record<string, unknown> = { ...baseConfig() };
    cfg.roles = { transformer: { initial_agents: 1 } };
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
      "transformer_1",
      "transformer_2",
      "transformer_3",
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

describe("buildGoldPlan", () => {
  const GOLD = {
    depositMinQtyCent: 80000,
    depositMaxQtyCent: 150000,
    coverageRatioBps: 10000,
    windowSpreadBps: 500,
    bankInitialReserveBps: 2000,
    bankInitialCapitalCents: 500000,
  };

  test("determinista: dos llamadas con la misma semilla producen el mismo plan", () => {
    const a = buildGoldPlan(1_400_000, { masterSeed: 42, gold: GOLD });
    const b = buildGoldPlan(1_400_000, { masterSeed: 42, gold: GOLD });
    expect(a).toEqual(b);
  });

  test("el sorteo D es rngFor(masterSeed, GOLD_DEPOSIT_RNG_KEY) en el rango", () => {
    const plan = buildGoldPlan(1_400_000, { masterSeed: 42, gold: GOLD });
    const expected = randIntInclusive(
      rngFor(42, GOLD_DEPOSIT_RNG_KEY),
      GOLD.depositMinQtyCent,
      GOLD.depositMaxQtyCent,
    );
    expect(plan.depositQtyCent).toBe(expected);
    expect(plan.depositQtyCent).toBeGreaterThanOrEqual(GOLD.depositMinQtyCent);
    expect(plan.depositQtyCent).toBeLessThanOrEqual(GOLD.depositMaxQtyCent);
  });

  test("otra semilla maestra cambia el yacimiento", () => {
    const a = buildGoldPlan(1_400_000, { masterSeed: 42, gold: GOLD });
    const b = buildGoldPlan(1_400_000, { masterSeed: 43, gold: GOLD });
    expect(a.depositQtyCent).not.toBe(b.depositQtyCent);
  });

  test("reparto: banco + minable = D, con floor en la reserva del banco", () => {
    const plan = buildGoldPlan(1_400_000, { masterSeed: 42, gold: GOLD });
    expect(plan.bankGoldQtyCent + plan.minableQtyCent).toBe(plan.depositQtyCent);
    expect(plan.bankGoldQtyCent).toBe(
      Math.floor((plan.depositQtyCent * GOLD.bankInitialReserveBps) / 10000),
    );
  });

  test("masa inicial = capital de mercado + capital del banco; paridad y banda coherentes", () => {
    const plan = buildGoldPlan(1_400_000, { masterSeed: 42, gold: GOLD });
    expect(plan.initialMoneyCents).toBe(1_400_000 + GOLD.bankInitialCapitalCents);
    const expectedParity = Number(
      (BigInt(plan.initialMoneyCents) * BigInt(GOLD.coverageRatioBps)) /
        (100n * BigInt(plan.depositQtyCent)),
    );
    expect(plan.parityCentsPerUnit).toBe(expectedParity);
    const half = Math.floor((plan.parityCentsPerUnit * GOLD.windowSpreadBps) / 10000);
    expect(plan.windowBidCents).toBe(plan.parityCentsPerUnit - half);
    expect(plan.windowAskCents).toBe(plan.parityCentsPerUnit + half);
    expect(plan.windowBidCents).toBeGreaterThan(0);
  });

  test("fail-fast: masa ridícula frente al yacimiento ⇒ paridad < 1 lanza", () => {
    expect(() =>
      buildGoldPlan(10, {
        masterSeed: 42,
        gold: { ...GOLD, bankInitialCapitalCents: 0 },
      }),
    ).toThrow(/paridad calculada/);
  });
});
