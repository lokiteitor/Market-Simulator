/**
 * Rendimiento decreciente de los yacimientos finitos (ADR-023) — sin DB.
 *
 * Las invariantes que importan: el rendimiento cae con el vaciado pero nunca
 * baja del suelo, un yacimiento vacío rinde 0, y la cola termina llegando a 0
 * de verdad (si no, el recurso sería infinito con output infinitesimal).
 */
import { describe, expect, test } from "bun:test";

import { depositYield, depositYieldBps } from "../../../src/lib/deposits";

const FLOOR = 2500;

describe("depositYieldBps", () => {
  test("yacimiento intacto: rendimiento pleno (10000 bps)", () => {
    expect(depositYieldBps(100_000, 100_000, FLOOR)).toBe(10000);
  });

  test("cae linealmente con la fracción restante", () => {
    expect(depositYieldBps(100_000, 80_000, FLOOR)).toBe(8000);
    expect(depositYieldBps(100_000, 50_000, FLOOR)).toBe(5000);
  });

  test("el suelo corta la caída", () => {
    expect(depositYieldBps(100_000, 10_000, FLOOR)).toBe(FLOOR);
    expect(depositYieldBps(100_000, 1, FLOOR)).toBe(FLOOR);
  });

  test("yacimiento agotado: 0 aunque haya suelo", () => {
    expect(depositYieldBps(100_000, 0, FLOOR)).toBe(0);
  });

  test("inicial 0 (yacimiento minable vacío desde el seed): 0, sin dividir por cero", () => {
    expect(depositYieldBps(0, 0, FLOOR)).toBe(0);
  });

  test("suelo 10000 desactiva el decrecimiento (corte seco clásico)", () => {
    expect(depositYieldBps(100_000, 1, 10000)).toBe(10000);
    expect(depositYieldBps(100_000, 0, 10000)).toBe(0);
  });

  test("rechaza negativos y no-enteros", () => {
    expect(() => depositYieldBps(-1, 0, FLOOR)).toThrow();
    expect(() => depositYieldBps(100, -1, FLOOR)).toThrow();
    expect(() => depositYieldBps(100, 1.5, FLOOR)).toThrow();
  });
});

describe("depositYield", () => {
  test("yacimiento intacto: se produce lo planificado íntegro", () => {
    expect(depositYield(100_000, 100_000, 2000, FLOOR)).toEqual({
      producedQtyCent: 2000,
      remainingAfterCent: 98_000,
      yieldBps: 10000,
    });
  });

  test("a media vida se produce la mitad, y el yacimiento baja solo por lo extraído", () => {
    expect(depositYield(100_000, 50_000, 2000, FLOOR)).toEqual({
      producedQtyCent: 1000,
      remainingAfterCent: 49_000,
      yieldBps: 5000,
    });
  });

  test("en el suelo se produce el 25% de lo planificado", () => {
    expect(depositYield(100_000, 10_000, 2000, FLOOR)).toEqual({
      producedQtyCent: 500,
      remainingAfterCent: 9500,
      yieldBps: FLOOR,
    });
  });

  test("la cola se lleva el remanente exacto: el yacimiento llega a 0", () => {
    expect(depositYield(100_000, 300, 2000, FLOOR)).toEqual({
      producedQtyCent: 300,
      remainingAfterCent: 0,
      yieldBps: FLOOR,
    });
  });

  test("yacimiento agotado: no se produce nada", () => {
    expect(depositYield(100_000, 0, 2000, FLOOR)).toEqual({
      producedQtyCent: 0,
      remainingAfterCent: 0,
      yieldBps: 0,
    });
  });

  test("floor del escalado: planificado pequeño en el suelo puede rendir 0", () => {
    // 3 × 2500/10000 = 0.75 ⇒ floor 0. La ejecución quema salario sin producir.
    expect(depositYield(100_000, 10_000, 3, FLOOR).producedQtyCent).toBe(0);
  });

  test("nunca se extrae más de lo que queda", () => {
    const r = depositYield(100_000, 40_000, 1_000_000, FLOOR);
    expect(r.producedQtyCent).toBe(40_000);
    expect(r.remainingAfterCent).toBe(0);
  });

  test("agotamiento efectivo: extracciones repetidas terminan vaciando el yacimiento", () => {
    const inicial = 50_000;
    let remaining = inicial;
    let vueltas = 0;
    while (remaining > 0 && vueltas < 10_000) {
      remaining = depositYield(inicial, remaining, 1000, FLOOR).remainingAfterCent;
      vueltas += 1;
    }
    expect(remaining).toBe(0);
  });

  test("cantidades grandes sin pérdida de precisión (BigInt)", () => {
    const inicial = 1_000_000_000_000;
    expect(depositYield(inicial, inicial, 999_999_999, FLOOR).producedQtyCent).toBe(999_999_999);
  });
});
