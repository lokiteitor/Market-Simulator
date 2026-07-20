/**
 * Tests puros del flujo circular de ingreso de ciudades (sin DB):
 *   - splitIncomeByWeight: reparto ponderado por población.
 *   - splitFeeForCity: split del fee entre banco y ciudades (tasa de consumo).
 *
 * El invariante crítico en ambos es la CONSERVACIÓN EXACTA: lo repartido debe
 * sumar exactamente lo reclamado / el fee cobrado. Un céntimo perdido aquí
 * rompe el invariante monetario global (market_conservation_delta_cents != 0).
 */
import { describe, expect, test } from "bun:test";
import {
  splitFeeForCity,
  splitIncomeByWeight,
  type CityWeight,
} from "../../../src/services/city-income-service";

const sum = (xs: Array<{ amountCents: number }>): number =>
  xs.reduce((s, x) => s + x.amountCents, 0);

describe("splitIncomeByWeight", () => {
  test("reparte proporcional al peso de población", () => {
    const cities: CityWeight[] = [
      { agentId: "tokyo", populationWeight: 30000 },
      { agentId: "lima", populationWeight: 10000 },
    ];
    const out = splitIncomeByWeight(4000, cities);
    const byId = Object.fromEntries(out.map((d) => [d.agentId, d.amountCents]));
    expect(byId["tokyo"]).toBe(3000);
    expect(byId["lima"]).toBe(1000);
    expect(sum(out)).toBe(4000);
  });

  test("CONSERVACIÓN: el residuo del floor va a la ciudad de mayor peso", () => {
    // 3 ciudades de peso igual y 10 centavos: floor(10/3)=3 cada una = 9,
    // sobra 1 que debe ir a la primera de mayor peso (empate ⇒ la primera).
    const cities: CityWeight[] = [
      { agentId: "a", populationWeight: 1 },
      { agentId: "b", populationWeight: 1 },
      { agentId: "c", populationWeight: 1 },
    ];
    const out = splitIncomeByWeight(10, cities);
    expect(sum(out)).toBe(10);
    const byId = Object.fromEntries(out.map((d) => [d.agentId, d.amountCents]));
    expect(byId["a"]).toBe(4);
    expect(byId["b"]).toBe(3);
    expect(byId["c"]).toBe(3);
  });

  test("CONSERVACIÓN: se mantiene exacta con pesos dispares y montos primos", () => {
    const cities: CityWeight[] = [
      { agentId: "tokyo", populationWeight: 37400 },
      { agentId: "reykjavik", populationWeight: 240 },
      { agentId: "lima", populationWeight: 11000 },
      { agentId: "accra", populationWeight: 2500 },
    ];
    for (const claimed of [1, 7, 97, 1009, 65537, 1_000_003]) {
      const out = splitIncomeByWeight(claimed, cities);
      expect(sum(out)).toBe(claimed);
    }
  });

  test("una ciudad diminuta puede recibir 0 y no aparece en el reparto", () => {
    const cities: CityWeight[] = [
      { agentId: "tokyo", populationWeight: 1_000_000 },
      { agentId: "reykjavik", populationWeight: 1 },
    ];
    const out = splitIncomeByWeight(10, cities);
    // floor(10*1/1000001) = 0 ⇒ reykjavik no recibe; el total sigue cuadrando.
    expect(out.find((d) => d.agentId === "reykjavik")).toBeUndefined();
    expect(sum(out)).toBe(10);
  });

  test("casos borde: sin ciudades, monto 0/negativo o pesos nulos ⇒ vacío", () => {
    const cities: CityWeight[] = [{ agentId: "a", populationWeight: 5 }];
    expect(splitIncomeByWeight(100, [])).toEqual([]);
    expect(splitIncomeByWeight(0, cities)).toEqual([]);
    expect(splitIncomeByWeight(-5, cities)).toEqual([]);
    expect(splitIncomeByWeight(100, [{ agentId: "a", populationWeight: 0 }])).toEqual([]);
  });
});

describe("splitFeeForCity", () => {
  test("CONSERVACIÓN: banco + ciudades == fee cobrado, siempre", () => {
    for (const fee of [1, 2, 3, 5, 25, 99, 1234, 100_001]) {
      for (const bps of [0, 1, 2500, 5000, 7777, 10000]) {
        const { bankShareCents, cityShareCents } = splitFeeForCity(fee, bps);
        expect(bankShareCents + cityShareCents).toBe(fee);
        expect(bankShareCents).toBeGreaterThanOrEqual(0);
        expect(cityShareCents).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("bps=5000 parte el fee a la mitad (floor a la ciudad)", () => {
    expect(splitFeeForCity(100, 5000)).toEqual({ bankShareCents: 50, cityShareCents: 50 });
    // Impar: el floor deja el céntimo extra en el banco.
    expect(splitFeeForCity(101, 5000)).toEqual({ bankShareCents: 51, cityShareCents: 50 });
  });

  test("bps=0 deja todo al banco; bps=10000 todo a las ciudades", () => {
    expect(splitFeeForCity(77, 0)).toEqual({ bankShareCents: 77, cityShareCents: 0 });
    expect(splitFeeForCity(77, 10000)).toEqual({ bankShareCents: 0, cityShareCents: 77 });
  });

  test("fee 0 o negativo no produce reparto", () => {
    expect(splitFeeForCity(0, 5000)).toEqual({ bankShareCents: 0, cityShareCents: 0 });
    expect(splitFeeForCity(-10, 5000)).toEqual({ bankShareCents: 0, cityShareCents: 0 });
  });
});
