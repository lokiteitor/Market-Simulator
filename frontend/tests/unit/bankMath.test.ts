/**
 * bankMath.test.ts — total de conversión (floor con BigInt) y validación
 * client-side de la ventanilla del banco central.
 */
import { describe, expect, test } from "bun:test";

import {
  DIRECTION_LABEL,
  conversionPriceCents,
  conversionTotalCents,
  validateConversion,
  type ConversionCheck,
} from "../../src/pages/bank/bankMath";
import type { BankInfo } from "../../src/api/types";

describe("conversionTotalCents", () => {
  test("floor(qty × precio / 100) exacto", () => {
    // 12.34 oz a $8.20/oz → floor(1234 × 820 / 100) = 10118 ¢
    expect(conversionTotalCents(1234, 820)).toBe(10118);
  });

  test("aplica floor (sesgo conservador)", () => {
    // floor(15 × 33 / 100) = floor(4.95) = 4
    expect(conversionTotalCents(15, 33)).toBe(4);
  });

  test("cantidad ínfima redondea a 0 (conversion_below_minimum)", () => {
    expect(conversionTotalCents(1, 80)).toBe(0);
  });

  test("sin pérdida de precisión con magnitudes grandes (BigInt)", () => {
    // 9e15 × 100 desbordaría la aritmética float intermedia.
    expect(conversionTotalCents(9_000_000_000_000_000, 250)).toBe(
      22_500_000_000_000_000,
    );
  });
});

describe("conversionPriceCents", () => {
  const bank = {
    window_bid_cents: 800,
    window_ask_cents: 900,
  } as BankInfo;

  test("sell_gold usa el bid (el banco compra)", () => {
    expect(conversionPriceCents(bank, "sell_gold")).toBe(800);
  });

  test("buy_gold usa el ask (el banco vende)", () => {
    expect(conversionPriceCents(bank, "buy_gold")).toBe(900);
  });
});

describe("validateConversion", () => {
  const base: ConversionCheck = {
    direction: "sell_gold",
    qtyCent: 1000,
    priceCentsPerUnit: 820,
    goldAvailableCent: 5000,
    capitalAvailableCents: 100_000,
    bankGoldAvailableCent: 200_000,
  };

  test("conversión viable → null", () => {
    expect(validateConversion(base)).toBeNull();
    expect(validateConversion({ ...base, direction: "buy_gold" })).toBeNull();
  });

  test("cantidad no positiva o no entera", () => {
    expect(validateConversion({ ...base, qtyCent: 0 })).not.toBeNull();
    expect(validateConversion({ ...base, qtyCent: 10.5 })).not.toBeNull();
  });

  test("importe que redondea a 0 (conversion_below_minimum)", () => {
    expect(
      validateConversion({ ...base, qtyCent: 1, priceCentsPerUnit: 80 }),
    ).toMatch(/redondea/);
  });

  test("sell_gold sin oro suficiente (insufficient_inventory)", () => {
    expect(
      validateConversion({ ...base, qtyCent: 5001 }),
    ).toMatch(/oro disponible/);
  });

  test("buy_gold sin capital suficiente (insufficient_capital)", () => {
    expect(
      validateConversion({
        ...base,
        direction: "buy_gold",
        capitalAvailableCents: 100,
      }),
    ).toMatch(/Capital/);
  });

  test("buy_gold por encima de la reserva del banco (bank_insufficient_gold)", () => {
    expect(
      validateConversion({
        ...base,
        direction: "buy_gold",
        bankGoldAvailableCent: 999,
      }),
    ).toMatch(/reserva/);
  });
});

describe("DIRECTION_LABEL", () => {
  test("cubre ambas direcciones", () => {
    expect(DIRECTION_LABEL.sell_gold).toContain("acuña");
    expect(DIRECTION_LABEL.buy_gold).toContain("destruye");
  });
});
