/**
 * Tests puros de la siembra de ciudades (sin DB): parseo de infra/cities.json y
 * plan de siembra UNIFORME (ADR-029: todas las ciudades nacen idénticas y la
 * heterogeneidad se la gana cada una comprando vivienda).
 */
import { describe, expect, test } from "bun:test";
import { buildCityPlan, parseCitiesConfig } from "../../../src/seed";

const VALID = JSON.stringify({
  cities: [
    { username: "tokyo", display: "Tokyo" },
    { username: "reykjavik", display: "Reykjavik" },
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
      cities: [{ username: "lima" }, { username: "lima" }],
    });
    expect(() => parseCitiesConfig(dup)).toThrow(/username duplicado/);
  });

  test("rechaza usernames con caracteres no permitidos", () => {
    const bad = JSON.stringify({ cities: [{ username: "mexico city" }] });
    expect(() => parseCitiesConfig(bad)).toThrow(/estructura inválida/);
  });

  test("ignora una población declarada en el JSON (ya no es un dato de entrada)", () => {
    // Un cities.json antiguo (con population_weight) sigue parseando: el campo
    // simplemente se descarta, para que actualizar el backend no exija tocar el
    // fichero a mano.
    const legacy = JSON.stringify({
      cities: [{ username: "lima", population_weight: 11000 }],
    });
    const cfg = parseCitiesConfig(legacy);
    expect(cfg.cities[0]).toEqual({ username: "lima" });
  });
});

describe("buildCityPlan", () => {
  test("todas las ciudades nacen con la misma población y el mismo capital", () => {
    const plan = buildCityPlan(parseCitiesConfig(VALID), {
      initialPopulation: 1000,
      capitalCents: 1_400_000,
    });
    expect(plan).toHaveLength(2);
    expect(plan[0]).toEqual({
      username: "tokyo",
      population: 1000,
      capitalCents: 1_400_000,
    });
    // El punto del cambio: Tokyo ya NO arranca con ventaja sobre Reikiavik.
    expect(plan[1]).toEqual({
      username: "reykjavik",
      population: 1000,
      capitalCents: 1_400_000,
    });
  });

  test("es determinista: mismas entradas ⇒ mismo plan", () => {
    const cfg = parseCitiesConfig(VALID);
    const opts = { initialPopulation: 1000, capitalCents: 7 };
    expect(buildCityPlan(cfg, opts)).toEqual(buildCityPlan(cfg, opts));
  });
});

describe("infra/cities.json (fuente única compartida con bots-ciudad)", () => {
  test("el archivo real parsea y trae ~50 capitales con usernames únicos", async () => {
    const raw = await Bun.file(
      new URL("../../../../infra/cities.json", import.meta.url).pathname,
    ).text();
    const cfg = parseCitiesConfig(raw);
    expect(cfg.cities.length).toBeGreaterThanOrEqual(50);
    expect(new Set(cfg.cities.map((c) => c.username)).size).toBe(cfg.cities.length);
  });
});
