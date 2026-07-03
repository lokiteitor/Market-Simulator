import { describe, expect, test } from "bun:test";

import { config } from "../../../src/config";
import {
  feeCents,
  notionalCents,
  releaseForFill,
  reserveForQty,
  unitCostFromTotal,
} from "../../../src/lib/money";
import { randIntInclusive, rngFor } from "../../../src/lib/rng";

describe("notionalCents", () => {
  test("floor exacto: 1.5 unidades a 333 centavos = 499 (no 499.5)", () => {
    expect(notionalCents(150, 333)).toBe(499);
  });

  test("sin resto: 2 unidades a 100 centavos = 200", () => {
    expect(notionalCents(200, 100)).toBe(200);
  });

  test("cantidades sub-unitarias pequeñas: 0.01 unidades a 99 centavos = 0 (floor)", () => {
    expect(notionalCents(1, 99)).toBe(0);
  });

  test("valores grandes sin pérdida de precisión (BigInt interno)", () => {
    // 10^9 qtyCent × 10^7 cents / 100 = 10^14 — excede la precisión de float64
    // en productos intermedios, pero BigInt lo maneja exacto.
    expect(notionalCents(1_000_000_001, 10_000_001)).toBe(
      Number((1_000_000_001n * 10_000_001n) / 100n),
    );
  });

  test("rechaza no-enteros", () => {
    expect(() => notionalCents(1.5, 100)).toThrow();
    expect(() => notionalCents(100, 1.5)).toThrow();
  });
});

describe("feeCents", () => {
  const { fixedCents, rateBps } = config.fees;

  test("fee = fijo + floor(notional × rateBps / 10000)", () => {
    for (const notional of [0, 1, 99, 100, 3999, 4000, 123_456_789]) {
      const expected = fixedCents + Number((BigInt(notional) * BigInt(rateBps)) / 10000n);
      expect(feeCents(notional)).toBe(expected);
    }
  });

  test("notional 0 paga solo el fee fijo", () => {
    expect(feeCents(0)).toBe(fixedCents);
  });
});

describe("unitCostFromTotal", () => {
  test("floor: 1000 centavos entre 3 unidades (300 qtyCent) = 333", () => {
    expect(unitCostFromTotal(1000, 300)).toBe(333);
  });

  test("exacto cuando divide: 1000 centavos entre 2 unidades = 500", () => {
    expect(unitCostFromTotal(1000, 200)).toBe(500);
  });

  test("qtyCent <= 0 lanza", () => {
    expect(() => unitCostFromTotal(1000, 0)).toThrow();
    expect(() => unitCostFromTotal(1000, -5)).toThrow();
  });
});

describe("reserveForQty", () => {
  test("es exactamente el notional al precio límite", () => {
    expect(reserveForQty(150, 333)).toBe(notionalCents(150, 333));
    expect(reserveForQty(1, 1)).toBe(0);
  });
});

describe("telescopio de reservas (§5)", () => {
  test("secuencias aleatorias de fills: Σ liberaciones == reserva inicial y r >= cost", () => {
    const rng = rngFor(config.masterSeed, "money-telescope-test");
    for (let iter = 0; iter < 500; iter++) {
      const qtyOriginal = randIntInclusive(rng, 1, 100_000);
      const limit = randIntInclusive(rng, 1, 50_000);
      const reserve = reserveForQty(qtyOriginal, limit);

      let pending = qtyOriginal;
      let released = 0;
      let reserved = reserve;

      // Fills parciales hasta agotar (a veces cancelamos antes).
      const cancelEarly = rng() < 0.3;
      while (pending > 0) {
        if (cancelEarly && rng() < 0.25) break;
        const execQty = randIntInclusive(rng, 1, pending);
        const after = pending - execQty;
        const r = releaseForFill(pending, after, limit);
        // Precio efectivo p <= limit (el de la orden pasiva).
        const price = randIntInclusive(rng, 1, limit);
        const cost = notionalCents(execQty, price);

        // Propiedad §5: la liberación siempre cubre el costo.
        expect(r).toBeGreaterThanOrEqual(cost);
        // Nunca se libera más de lo que queda reservado.
        expect(r).toBeLessThanOrEqual(reserved);

        released += r;
        reserved -= r;
        pending = after;
      }

      // Cierre (fill total / cancel / expire): liberar notional(pending, limit).
      const closeRelease = notionalCents(pending, limit);
      released += closeRelease;
      reserved -= closeRelease;

      // El telescopio cierra EXACTO: sin residuos de redondeo.
      expect(released).toBe(reserve);
      expect(reserved).toBe(0);
    }
  });

  test("caso borde: liberaciones de fills minúsculos con precios con resto", () => {
    // qty=299 (2.99 unidades) a limit=333: reserva = floor(299*333/100) = 995.
    const limit = 333;
    let pending = 299;
    const reserve = reserveForQty(pending, limit);
    expect(reserve).toBe(995);

    let released = 0;
    while (pending > 0) {
      const r = releaseForFill(pending, pending - 1, limit);
      expect(r).toBeGreaterThanOrEqual(0);
      released += r;
      pending -= 1;
    }
    expect(released).toBe(reserve);
  });
});
