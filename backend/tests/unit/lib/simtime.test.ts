import { describe, expect, test } from "bun:test";

import { config } from "../../../src/config";
import {
  expiresAtFromTtl,
  intervalToSimSeconds,
  processExpectedEndAt,
  realMsToSimSeconds,
  simSecondsToRealMs,
  wageCentsForProcess,
} from "../../../src/lib/simtime";

const factor = config.simTimeFactor;

describe("simSecondsToRealMs / realMsToSimSeconds", () => {
  test("60 s simulados tardan 60000/factor ms reales", () => {
    expect(simSecondsToRealMs(60)).toBe(60000 / factor);
  });

  test("0 segundos = 0 ms", () => {
    expect(simSecondsToRealMs(0)).toBe(0);
  });

  test("roundtrip", () => {
    for (const s of [1, 60, 3600, 604800, 0.5]) {
      expect(realMsToSimSeconds(simSecondsToRealMs(s))).toBeCloseTo(s, 9);
    }
  });
});

describe("expiresAtFromTtl", () => {
  test("suma la duración real equivalente al TTL simulado", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const expires = expiresAtFromTtl(now, 60);
    expect(expires.getTime() - now.getTime()).toBe(60000 / factor);
  });
});

describe("processExpectedEndAt", () => {
  test("started_at + simSecondsToRealMs(duración × ejecuciones)", () => {
    const started = new Date("2026-01-01T00:00:00.000Z");
    const end = processExpectedEndAt(started, 3600, 2);
    expect(end.getTime() - started.getTime()).toBe((3600 * 2 * 1000) / factor);
  });
});

describe("wageCentsForProcess", () => {
  test("producto exacto de enteros", () => {
    expect(wageCentsForProcess(1, 3600, 2)).toBe(7200);
    expect(wageCentsForProcess(3, 60, 5)).toBe(900);
    expect(wageCentsForProcess(0, 3600, 10)).toBe(0);
  });

  test("rechaza no-enteros", () => {
    expect(() => wageCentsForProcess(1.5, 3600, 1)).toThrow();
  });
});

describe("intervalToSimSeconds", () => {
  test("formato HH:MM:SS", () => {
    expect(intervalToSimSeconds("01:00:00")).toBe(3600);
    expect(intervalToSimSeconds("00:01:00")).toBe(60);
    expect(intervalToSimSeconds("00:00:01")).toBe(1);
    expect(intervalToSimSeconds("10:20:30")).toBe(10 * 3600 + 20 * 60 + 30);
  });

  test("HH:MM (sin segundos)", () => {
    expect(intervalToSimSeconds("04:05")).toBe(4 * 3600 + 5 * 60);
  });

  test("fracciones de segundo", () => {
    expect(intervalToSimSeconds("00:00:00.5")).toBeCloseTo(0.5, 9);
    expect(intervalToSimSeconds("00:00:01.25")).toBeCloseTo(1.25, 9);
  });

  test("días + parte horaria", () => {
    expect(intervalToSimSeconds("1 day 02:03:04")).toBe(86400 + 2 * 3600 + 3 * 60 + 4);
    expect(intervalToSimSeconds("2 days")).toBe(172800);
    expect(intervalToSimSeconds("1 day")).toBe(86400);
  });

  test("meses y años (equivalencia EXTRACT(EPOCH ...) de Postgres)", () => {
    expect(intervalToSimSeconds("1 mon")).toBe(2_592_000); // 30 días
    expect(intervalToSimSeconds("2 mons")).toBe(5_184_000);
    expect(intervalToSimSeconds("1 year")).toBe(31_557_600); // 365.25 días
    expect(intervalToSimSeconds("1 year 2 mons 3 days 04:05:06")).toBe(
      31_557_600 + 5_184_000 + 3 * 86400 + 4 * 3600 + 5 * 60 + 6,
    );
  });

  test("signos por componente (estilo postgres)", () => {
    expect(intervalToSimSeconds("-1 days +02:03:00")).toBe(-86400 + 2 * 3600 + 3 * 60);
    expect(intervalToSimSeconds("-00:01:00")).toBe(-60);
  });

  test("estilo postgres_verbose", () => {
    expect(intervalToSimSeconds("@ 1 day 2 hours 3 mins 4 secs")).toBe(
      86400 + 2 * 3600 + 3 * 60 + 4,
    );
    expect(intervalToSimSeconds("@ 1 hour ago")).toBe(-3600);
    expect(intervalToSimSeconds("2 hours 30 mins")).toBe(2 * 3600 + 30 * 60);
    expect(intervalToSimSeconds("90 seconds")).toBe(90);
    expect(intervalToSimSeconds("1 minute")).toBe(60);
  });

  test("milisegundos", () => {
    expect(intervalToSimSeconds("500 ms")).toBeCloseTo(0.5, 9);
    expect(intervalToSimSeconds("250 milliseconds")).toBeCloseTo(0.25, 9);
  });

  test("insensible a mayúsculas y espacios extra", () => {
    expect(intervalToSimSeconds("  1 DAY 02:00:00 ")).toBe(86400 + 7200);
  });

  test("entradas inválidas lanzan", () => {
    expect(() => intervalToSimSeconds("")).toThrow();
    expect(() => intervalToSimSeconds("   ")).toThrow();
    expect(() => intervalToSimSeconds("garbage")).toThrow();
    expect(() => intervalToSimSeconds("12 parsecs")).toThrow();
  });
});
