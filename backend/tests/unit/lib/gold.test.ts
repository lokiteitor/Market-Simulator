import { describe, expect, test } from "bun:test";

import {
  goldWindow,
  issuanceCapacityCents,
  parityCentsPerUnit,
  splitDeposit,
} from "../../../src/lib/gold";

describe("parityCentsPerUnit", () => {
  test("cobertura 100%: parity = floor(M0 / (D/100))", () => {
    // M0 = 1_400_000 cents, D = 100_000 qtyCent (1000 kg) ⇒ 1400 c/kg exacto.
    expect(parityCentsPerUnit(1_400_000, 100_000, 10000)).toBe(1400);
  });

  test("floor con resto: 1_000_000 / (1500 kg) = 666.66… ⇒ 666", () => {
    expect(parityCentsPerUnit(1_000_000, 150_000, 10000)).toBe(666);
  });

  test("cobertura 50% (5000 bps) reduce la paridad a la mitad", () => {
    expect(parityCentsPerUnit(1_400_000, 100_000, 5000)).toBe(700);
  });

  test("cobertura 200% (20000 bps) duplica la paridad", () => {
    expect(parityCentsPerUnit(1_400_000, 100_000, 20000)).toBe(2800);
  });

  test("fail-fast: paridad < 1 lanza (yacimiento enorme vs masa pequeña)", () => {
    expect(() => parityCentsPerUnit(100, 1_000_000, 10000)).toThrow(/paridad calculada/);
  });

  test("rechaza depósito <= 0 y no-enteros", () => {
    expect(() => parityCentsPerUnit(1_000_000, 0, 10000)).toThrow();
    expect(() => parityCentsPerUnit(1_000_000.5, 100_000, 10000)).toThrow();
  });
});

describe("goldWindow", () => {
  test("spread 500 bps: half = floor(1400 × 0.05) = 70 ⇒ bid 1330 / ask 1470", () => {
    expect(goldWindow(1400, 500)).toEqual({ bidCents: 1330, askCents: 1470 });
  });

  test("spread 0: bid = ask = parity", () => {
    expect(goldWindow(1400, 0)).toEqual({ bidCents: 1400, askCents: 1400 });
  });

  test("floor del half: parity 999 × 500 bps = 49.95 ⇒ 49", () => {
    expect(goldWindow(999, 500)).toEqual({ bidCents: 950, askCents: 1048 });
  });

  test("fail-fast: bid < 1 lanza (spread que devora la paridad)", () => {
    expect(() => goldWindow(1, 9999)).not.toThrow(); // half = 0 ⇒ bid 1, válido
    expect(() => goldWindow(2, 5000)).not.toThrow(); // half = 1 ⇒ bid 1, válido
    expect(() => goldWindow(1, 10000)).toThrow(/bid calculado/); // half = 1 ⇒ bid 0
  });
});

describe("issuanceCapacityCents", () => {
  test("cobertura 100%: capacidad = valor del oro a paridad", () => {
    // 200 kg (20_000 qtyCent) a 1400 c/kg = 280_000; cobertura 100% ⇒ 280_000.
    expect(issuanceCapacityCents(20_000, 1400, 10000)).toBe(280_000);
  });

  test("cobertura 200%: capacidad = mitad del valor del oro", () => {
    expect(issuanceCapacityCents(20_000, 1400, 20000)).toBe(140_000);
  });

  test("cobertura 50%: capacidad = doble del valor del oro", () => {
    expect(issuanceCapacityCents(20_000, 1400, 5000)).toBe(560_000);
  });

  test("doble floor: primero el valor del oro, luego la capacidad", () => {
    // 0.33 kg (33 qtyCent) a 999 c/kg: floor(33×999/100)=329; 100% ⇒ 329.
    expect(issuanceCapacityCents(33, 999, 10000)).toBe(329);
  });

  test("banco sin oro ⇒ capacidad 0", () => {
    expect(issuanceCapacityCents(0, 1400, 10000)).toBe(0);
  });
});

describe("splitDeposit", () => {
  test("20% de reserva: floor y remanente complementario exacto", () => {
    expect(splitDeposit(100_000, 2000)).toEqual({
      bankGoldQtyCent: 20_000,
      minableQtyCent: 80_000,
    });
  });

  test("floor con resto: 99_999 × 20% = 19_999.8 ⇒ 19_999 + 80_000", () => {
    const r = splitDeposit(99_999, 2000);
    expect(r.bankGoldQtyCent).toBe(19_999);
    expect(r.bankGoldQtyCent + r.minableQtyCent).toBe(99_999);
  });

  test("0 bps: todo minable; 10000 bps: todo al banco", () => {
    expect(splitDeposit(100_000, 0)).toEqual({ bankGoldQtyCent: 0, minableQtyCent: 100_000 });
    expect(splitDeposit(100_000, 10000)).toEqual({
      bankGoldQtyCent: 100_000,
      minableQtyCent: 0,
    });
  });
});

// El clamp de la producción contra el yacimiento se probó aquí mientras fue
// exclusivo del oro; vive en tests/unit/lib/deposits.test.ts desde ADR-023.
