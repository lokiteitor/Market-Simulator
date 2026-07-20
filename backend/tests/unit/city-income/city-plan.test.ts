/**
 * Tests puros de la siembra de ciudades (sin DB): parseo de infra/cities.json y
 * plan determinista de capital semilla ∝ population_weight.
 */
import { describe, expect, test } from "bun:test";
import { buildCityPlan, parseCitiesConfig } from "../../../src/seed";

const VALID = JSON.stringify({
  cities: [
    { username: "tokyo", display: "Tokyo", population_weight: 37400 },
    { username: "reykjavik", display: "Reykjavik", population_weight: 240 },
  ],
});

describe("parseCitiesConfig", () => {
  test("acepta una config válida", () => {
    const cfg = parseCitiesConfig(VALID);
    expect(cfg.cities).toHaveLength(2);
    expect(cfg.cities[0]?.username).toBe("tokyo");
  });

  test("rechaza JSON inválido", () => {
    expect(() => parseCitiesConfig("{no es json")).toThrow(/JSON inválido/);
  });

  test("rechaza usernames duplicados (colisionarían al sembrar)", () => {
    const dup = JSON.stringify({
      cities: [
        { username: "lima", population_weight: 100 },
        { username: "lima", population_weight: 200 },
      ],
    });
    expect(() => parseCitiesConfig(dup)).toThrow(/username duplicado/);
  });

  test("rechaza peso de población no positivo", () => {
    const bad = JSON.stringify({ cities: [{ username: "lima", population_weight: 0 }] });
    expect(() => parseCitiesConfig(bad)).toThrow(/estructura inválida/);
  });

  test("rechaza usernames con caracteres no permitidos", () => {
    const bad = JSON.stringify({
      cities: [{ username: "mexico city", population_weight: 10 }],
    });
    expect(() => parseCitiesConfig(bad)).toThrow(/estructura inválida/);
  });
});

describe("buildCityPlan", () => {
  test("capital semilla proporcional al peso (Tokyo ≫ Reikiavik)", () => {
    const plan = buildCityPlan(parseCitiesConfig(VALID), { capitalCentsPerWeight: 50 });
    expect(plan).toHaveLength(2);
    expect(plan[0]).toEqual({
      username: "tokyo",
      populationWeight: 37400,
      capitalCents: 37400 * 50,
    });
    expect(plan[1]?.capitalCents).toBe(240 * 50);
    // La proporción se conserva exactamente.
    expect(plan[0]!.capitalCents / plan[1]!.capitalCents).toBeCloseTo(37400 / 240);
  });

  test("es determinista: mismas entradas ⇒ mismo plan", () => {
    const cfg = parseCitiesConfig(VALID);
    const a = buildCityPlan(cfg, { capitalCentsPerWeight: 7 });
    const b = buildCityPlan(cfg, { capitalCentsPerWeight: 7 });
    expect(a).toEqual(b);
  });
});

describe("infra/cities.json (fuente única compartida con bots-ciudad)", () => {
  test("el archivo real parsea y trae ~50 capitales con pesos positivos", async () => {
    const raw = await Bun.file(
      new URL("../../../../infra/cities.json", import.meta.url).pathname,
    ).text();
    const cfg = parseCitiesConfig(raw);
    expect(cfg.cities.length).toBeGreaterThanOrEqual(50);
    for (const c of cfg.cities) {
      expect(c.population_weight).toBeGreaterThan(0);
    }
  });
});
