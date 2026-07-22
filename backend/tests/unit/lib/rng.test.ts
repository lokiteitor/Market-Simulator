import { describe, expect, test } from "bun:test";

import {
  fnv1a32,
  mulberry32,
  randIntInclusive,
  rngFor,
  seedFrom,
} from "../../../src/lib/rng";

describe("fnv1a32", () => {
  test("vectores conocidos", () => {
    // Vectores de referencia FNV-1a de 32 bits.
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });
});

describe("seedFrom", () => {
  test("determinista: misma (semilla, clave) → misma semilla derivada", () => {
    expect(seedFrom(42, "transformer_1")).toBe(seedFrom(42, "transformer_1"));
  });

  test("claves distintas → semillas distintas", () => {
    const keys = ["transformer_1", "transformer_2", "trader_1", "trader_2"];
    const seeds = new Set(keys.map((k) => seedFrom(42, k)));
    expect(seeds.size).toBe(keys.length);
  });

  test("semillas maestras distintas → semillas derivadas distintas", () => {
    expect(seedFrom(42, "agent")).not.toBe(seedFrom(43, "agent"));
  });

  test("devuelve un uint32", () => {
    for (const [m, k] of [[42, "a"], [0, ""], [-1, "x"], [2 ** 31, "y"]] as const) {
      const s = seedFrom(m, k);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("mulberry32", () => {
  test("determinista: misma semilla → misma secuencia", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      expect(a()).toBe(b());
    }
  });

  test("semillas distintas → secuencias distintas", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  test("valores en [0, 1)", () => {
    const rng = mulberry32(987654321);
    for (let i = 0; i < 10_000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("rngFor", () => {
  test("equivale a mulberry32(seedFrom(...))", () => {
    const a = rngFor(42, "agent_1");
    const b = mulberry32(seedFrom(42, "agent_1"));
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });
});

describe("randIntInclusive", () => {
  test("respeta los límites y toca ambos extremos", () => {
    const rng = rngFor(42, "randint-test");
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) {
      const v = randIntInclusive(rng, 3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      expect(Number.isInteger(v)).toBe(true);
      seen.add(v);
    }
    expect(seen).toEqual(new Set([3, 4, 5, 6, 7]));
  });

  test("min === max devuelve siempre min", () => {
    const rng = rngFor(42, "degenerate");
    for (let i = 0; i < 100; i++) {
      expect(randIntInclusive(rng, 5, 5)).toBe(5);
    }
  });

  test("rangos de capital semilla (§13) reproducibles por agente", () => {
    const draw = () => randIntInclusive(rngFor(42, "transformer_1"), 50000, 120000);
    const first = draw();
    expect(draw()).toBe(first);
    expect(first).toBeGreaterThanOrEqual(50000);
    expect(first).toBeLessThanOrEqual(120000);
  });

  test("min > max lanza", () => {
    const rng = rngFor(42, "invalid");
    expect(() => randIntInclusive(rng, 10, 9)).toThrow();
  });

  test("no-enteros lanzan", () => {
    const rng = rngFor(42, "invalid2");
    expect(() => randIntInclusive(rng, 0.5, 10)).toThrow();
  });
});
