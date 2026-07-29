/**
 * Tests puros de la dinámica de población de las ciudades (ADR-029), sin DB.
 *
 * Lo que se protege aquí es el bucle económico completo: la vivienda absorbida
 * hace crecer, el decaimiento encoge, y el SUELO garantiza que la demanda final
 * nunca se apaga. Un error de signo o un floor mal puesto se traduce en ciudades
 * que crecen sin freno o que mueren, y en ambos casos la economía se rompe.
 */
import { describe, expect, test } from "bun:test";
import {
  applyPopulationDynamics,
  elapsedSimSecondsFor,
} from "../../../src/services/city-consumption-service";

const SIM_DAY = 86_400;
/** Parámetros de referencia: los defaults del .env (4 hab/vivienda, 11 bps/día). */
const P = { habitantsPerHousing: 4, decayBpsPerSimDay: 11, floor: 1000 };

describe("applyPopulationDynamics — crecimiento por vivienda", () => {
  test("cada unidad entera de vivienda suma habitantsPerHousing", () => {
    // 3 unidades = 300 qty_cent ⇒ +12 habitantes.
    const out = applyPopulationDynamics(1000, 300, 0, P);
    expect(out.habitantsGained).toBe(12);
    expect(out.populationAfter).toBe(1012);
  });

  test("media vivienda no aloja a nadie (solo cuentan unidades enteras)", () => {
    const out = applyPopulationDynamics(1000, 50, 0, P);
    expect(out.habitantsGained).toBe(0);
    expect(out.populationAfter).toBe(1000);
  });

  test("sin vivienda y sin tiempo, la población no se mueve", () => {
    const out = applyPopulationDynamics(1234, 0, 0, P);
    expect(out).toEqual({ populationAfter: 1234, habitantsGained: 0, habitantsLost: 0 });
  });
});

describe("applyPopulationDynamics — decaimiento", () => {
  test("un día simulado erosiona decayBpsPerSimDay de la población", () => {
    // 11 bps de 100.000 = 110 habitantes.
    const out = applyPopulationDynamics(100_000, 0, SIM_DAY, P);
    expect(out.habitantsLost).toBe(110);
    expect(out.populationAfter).toBe(99_890);
  });

  test("es proporcional al Δt: medio día pierde la mitad", () => {
    const out = applyPopulationDynamics(100_000, 0, SIM_DAY / 2, P);
    expect(out.habitantsLost).toBe(55);
  });

  test("SUELO: una ciudad en su población inicial no pierde a nadie", () => {
    // Es lo que garantiza que la demanda final nunca se apague del todo.
    const out = applyPopulationDynamics(1000, 0, 10 * SIM_DAY, P);
    expect(out.habitantsLost).toBe(0);
    expect(out.populationAfter).toBe(1000);
  });

  test("SUELO: el decaimiento se recorta justo al llegar, nunca lo cruza", () => {
    // 1010 hab con un decaimiento brutal (50%/día-sim) durante un día entero:
    // perdería 505, pero solo puede caer los 10 que le sobran del suelo.
    const out = applyPopulationDynamics(1010, 0, SIM_DAY, {
      ...P,
      decayBpsPerSimDay: 5000,
    });
    expect(out.habitantsLost).toBe(10);
    expect(out.populationAfter).toBe(1000);
  });

  test("la vivienda absorbida NO decae en la misma pasada", () => {
    // Se decae sobre la población de entrada (100.000 ⇒ 110) y después se suman
    // los 4 habitantes de la casa nueva: 100.000 − 110 + 4.
    const out = applyPopulationDynamics(100_000, 100, SIM_DAY, P);
    expect(out.habitantsLost).toBe(110);
    expect(out.habitantsGained).toBe(4);
    expect(out.populationAfter).toBe(99_894);
  });

  test("Δt corto en una ciudad pequeña redondea a 0 (sesgo conservador)", () => {
    // 1100 hab durante 10 s simulados: 1100×11×10/(10000×86400) ≈ 0,00014.
    // Se trunca a 0 en vez de inventar hambre.
    const out = applyPopulationDynamics(1100, 0, 10, P);
    expect(out.habitantsLost).toBe(0);
  });

  test("crecer no tiene techo: una ciudad grande sigue creciendo", () => {
    const out = applyPopulationDynamics(500_000, 10_000, 0, P);
    expect(out.populationAfter).toBe(500_400);
  });

  test("decayBps 0 desactiva el decaimiento", () => {
    const out = applyPopulationDynamics(100_000, 0, 100 * SIM_DAY, {
      ...P,
      decayBpsPerSimDay: 0,
    });
    expect(out.habitantsLost).toBe(0);
  });

  test("rechaza entradas no enteras o negativas (bug del caller)", () => {
    expect(() => applyPopulationDynamics(-1, 0, 0, P)).toThrow(/entero seguro/);
    expect(() => applyPopulationDynamics(1000, -5, 0, P)).toThrow(/entero seguro/);
    expect(() => applyPopulationDynamics(1000, 0, -1, P)).toThrow(/>= 0/);
  });
});

describe("elapsedSimSecondsFor", () => {
  const now = new Date("2026-07-29T12:00:00.000Z");
  const opts = { simTimeFactor: 5, maxCatchupSimSeconds: 3600 };

  test("convierte el hueco real a segundos simulados con el factor", () => {
    const hace10s = new Date(now.getTime() - 10_000);
    expect(elapsedSimSecondsFor(hace10s, now, opts)).toBe(50);
  });

  test("TECHO: tras una caída larga del worker el Δt se clampea", () => {
    // Sin el techo, la primera pasada tras 3 días de parón arrasaría el
    // inventario de todas las ciudades y les aplicaría el decaimiento de golpe.
    const hace3dias = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
    expect(elapsedSimSecondsFor(hace3dias, now, opts)).toBe(3600);
  });

  test("last_consumption_at NULL ⇒ 0 (la pasada solo sella el instante)", () => {
    expect(elapsedSimSecondsFor(null, now, opts)).toBe(0);
  });

  test("reloj hacia atrás ⇒ 0, nunca negativo", () => {
    const futuro = new Date(now.getTime() + 60_000);
    expect(elapsedSimSecondsFor(futuro, now, opts)).toBe(0);
  });
});
