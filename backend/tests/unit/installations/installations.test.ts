import { describe, expect, test } from "bun:test";
import { installationUpgradePriceCents } from "../../../src/lib/installations";

describe("installationUpgradePriceCents", () => {
  test("nivel 0 (compra inicial) = precio base", () => {
    expect(installationUpgradePriceCents(15000, 17000, 0)).toBe(15000);
  });

  test("escalado ×1.7 por nivel (floor)", () => {
    // 15000 × 17000/10000 = 25500
    expect(installationUpgradePriceCents(15000, 17000, 1)).toBe(25500);
    // 15000 × (17000/10000)^2 = 43350
    expect(installationUpgradePriceCents(15000, 17000, 2)).toBe(43350);
    // 15000 × (17000/10000)^3 = 73695
    expect(installationUpgradePriceCents(15000, 17000, 3)).toBe(73695);
  });

  test("growthBps 10000 (×1) mantiene el precio constante", () => {
    expect(installationUpgradePriceCents(40000, 10000, 5)).toBe(40000);
  });

  test("redondeo floor en niveles altos (sin drift de punto flotante)", () => {
    // 80000 × (17000/10000)^9 = 80000 × 17000^9 / 10000^9, floor exacto BigInt.
    const g = 17000n;
    const expected = Number((80000n * g ** 9n) / 10000n ** 9n);
    expect(installationUpgradePriceCents(80000, 17000, 9)).toBe(expected);
  });

  test("rechaza argumentos inválidos", () => {
    expect(() => installationUpgradePriceCents(0, 17000, 0)).toThrow();
    expect(() => installationUpgradePriceCents(15000, 0, 0)).toThrow();
    expect(() => installationUpgradePriceCents(15000, 17000, -1)).toThrow();
  });
});
