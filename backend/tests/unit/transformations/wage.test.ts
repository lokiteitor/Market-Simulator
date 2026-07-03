/**
 * Tests puros de cálculo de salario de proceso (contrato §4) — [M4].
 * salario = wage_rate_cents_per_sec × intervalToSimSeconds(duration) × executions
 */
import { describe, expect, test } from "bun:test";
import { processWageCents } from "../../../src/services/transformation-service";

describe("processWageCents", () => {
  test("germinado_rapido: 60 s sim × 1 c/s × 1 ejecución = 60", () => {
    expect(processWageCents("00:01:00", 1, 1)).toBe(60);
  });

  test("1 hora × 2 c/s × 3 ejecuciones = 21600", () => {
    expect(processWageCents("01:00:00", 2, 3)).toBe(3600 * 2 * 3);
  });

  test("interval estilo 'postgres' con días: '2 days' × 1 c/s = 172800", () => {
    expect(processWageCents("2 days", 1, 1)).toBe(172_800);
  });

  test("interval mixto '1 day 02:03:04'", () => {
    expect(processWageCents("1 day 02:03:04", 1, 1)).toBe(86_400 + 2 * 3600 + 3 * 60 + 4);
  });

  test("producto exacto con valores grandes (BigInt, sin drift de float)", () => {
    // 7 días sim × 1000 c/s × 1000 ejecuciones = 604 800 000 000 (entero exacto)
    expect(processWageCents("7 days", 1000, 1000)).toBe(604_800_000_000);
  });

  test("wage_rate 0 ⇒ salario 0 (recetas gratuitas)", () => {
    expect(processWageCents("01:00:00", 0, 5)).toBe(0);
  });

  test("una duración no entera en segundos lanza (invariante de datos)", () => {
    expect(() => processWageCents("500 ms", 1, 1)).toThrow();
  });

  test("interval vacío lanza", () => {
    expect(() => processWageCents("", 1, 1)).toThrow();
  });
});
