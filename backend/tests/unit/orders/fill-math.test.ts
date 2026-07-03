import { describe, expect, test } from "bun:test";

import { config } from "../../../src/config";
import { feeCents, notionalCents, reserveForQty } from "../../../src/lib/money";
import { randIntInclusive, rngFor } from "../../../src/lib/rng";
import {
  buyerLotUnitCostCents,
  cappedFeeCents,
  planFill,
  pricesCross,
} from "../../../src/services/matching/fill-math";

describe("pricesCross", () => {
  test("taker buy cruza con sell de limit menor o igual", () => {
    expect(pricesCross("buy", 100, 100)).toBe(true);
    expect(pricesCross("buy", 100, 99)).toBe(true);
    expect(pricesCross("buy", 100, 101)).toBe(false);
  });

  test("taker sell cruza con buy de limit mayor o igual", () => {
    expect(pricesCross("sell", 100, 100)).toBe(true);
    expect(pricesCross("sell", 100, 101)).toBe(true);
    expect(pricesCross("sell", 100, 99)).toBe(false);
  });
});

describe("planFill — taker buy", () => {
  // taker: compra 5.00 unidades a limit 10.00; pasiva: vende 3.00 a 9.00.
  const plan = planFill({
    takerSide: "buy",
    takerQtyPendingCent: 500,
    takerLimitPriceCents: 1000,
    passiveQtyPendingCent: 300,
    passiveLimitPriceCents: 900,
  });

  test("qty = min(pendientes); precio = el de la PASIVA", () => {
    expect(plan.execQtyCent).toBe(300);
    expect(plan.priceCents).toBe(900);
  });

  test("cost = notional(execQty, precio pasivo)", () => {
    expect(plan.costCents).toBe(notionalCents(300, 900)); // 2700
  });

  test("liberación telescópica contra el limit del COMPRADOR (taker)", () => {
    // notional(500,1000) - notional(200,1000) = 5000 - 2000 = 3000
    expect(plan.buyerReserveReleaseCents).toBe(3000);
    expect(plan.buyerRefundCents).toBe(3000 - 2700);
  });

  test("fee ideal por lado = feeCents(cost)", () => {
    expect(plan.idealFeeCents).toBe(feeCents(2700));
  });

  test("pendientes y fills resultantes", () => {
    expect(plan.takerQtyPendingAfterCent).toBe(200);
    expect(plan.passiveQtyPendingAfterCent).toBe(0);
    expect(plan.takerFill).toBe("partial");
    expect(plan.passiveFill).toBe("full");
  });
});

describe("planFill — taker sell", () => {
  // taker: vende 3.00 a limit 9.00; pasiva: compra 5.00 a 10.00.
  const plan = planFill({
    takerSide: "sell",
    takerQtyPendingCent: 300,
    takerLimitPriceCents: 900,
    passiveQtyPendingCent: 500,
    passiveLimitPriceCents: 1000,
  });

  test("precio = el de la pasiva (buy) ⇒ el limit del comprador", () => {
    expect(plan.priceCents).toBe(1000);
    expect(plan.execQtyCent).toBe(300);
    expect(plan.costCents).toBe(notionalCents(300, 1000)); // 3000
  });

  test("la liberación se calcula sobre la orden PASIVA (compradora)", () => {
    // notional(500,1000) - notional(200,1000) = 3000; refund = 0 (p == limit)
    expect(plan.buyerReserveReleaseCents).toBe(3000);
    expect(plan.buyerRefundCents).toBe(0);
  });

  test("fills", () => {
    expect(plan.takerFill).toBe("full");
    expect(plan.passiveFill).toBe("partial");
  });
});

describe("planFill — validaciones de invariantes", () => {
  test("precios que no cruzan ⇒ Error", () => {
    expect(() =>
      planFill({
        takerSide: "buy",
        takerQtyPendingCent: 100,
        takerLimitPriceCents: 100,
        passiveQtyPendingCent: 100,
        passiveLimitPriceCents: 101,
      }),
    ).toThrow();
  });

  test("pendientes no positivos ⇒ Error", () => {
    expect(() =>
      planFill({
        takerSide: "sell",
        takerQtyPendingCent: 0,
        takerLimitPriceCents: 100,
        passiveQtyPendingCent: 100,
        passiveLimitPriceCents: 100,
      }),
    ).toThrow();
  });
});

describe("propiedad §5: release >= cost y telescopio exacto", () => {
  test("fills aleatorios: la liberación cubre el costo y el refund es no-negativo", () => {
    const rng = rngFor(config.masterSeed, "orders-fill-math-release");
    for (let i = 0; i < 1000; i++) {
      const takerSide = rng() < 0.5 ? ("buy" as const) : ("sell" as const);
      const buyerLimit = randIntInclusive(rng, 1, 50_000);
      // el precio pasivo compatible: sell limit <= buy limit si taker compra;
      // si taker vende, la pasiva ES la compradora (precio = su limit).
      const sellerLimit = randIntInclusive(rng, 1, buyerLimit);
      const takerQty = randIntInclusive(rng, 1, 100_000);
      const passiveQty = randIntInclusive(rng, 1, 100_000);

      const plan = planFill(
        takerSide === "buy"
          ? {
              takerSide,
              takerQtyPendingCent: takerQty,
              takerLimitPriceCents: buyerLimit,
              passiveQtyPendingCent: passiveQty,
              passiveLimitPriceCents: sellerLimit,
            }
          : {
              takerSide,
              takerQtyPendingCent: takerQty,
              takerLimitPriceCents: sellerLimit,
              passiveQtyPendingCent: passiveQty,
              passiveLimitPriceCents: buyerLimit,
            },
      );

      expect(plan.execQtyCent).toBe(Math.min(takerQty, passiveQty));
      expect(plan.buyerReserveReleaseCents).toBeGreaterThanOrEqual(plan.costCents);
      expect(plan.buyerRefundCents).toBe(plan.buyerReserveReleaseCents - plan.costCents);
      expect(plan.buyerRefundCents).toBeGreaterThanOrEqual(0);
    }
  });

  test("una orden de compra pasiva consumida por N takers sell: la reserva cierra en 0", () => {
    const rng = rngFor(config.masterSeed, "orders-fill-math-telescope");
    for (let iter = 0; iter < 200; iter++) {
      const buyLimit = randIntInclusive(rng, 1, 10_000);
      const buyQty = randIntInclusive(rng, 1, 50_000);
      let reserved = reserveForQty(buyQty, buyLimit);
      let pending = buyQty;

      while (pending > 0) {
        const takerQty = randIntInclusive(rng, 1, pending);
        // taker sell con limit <= buyLimit (cruza); precio efectivo = buyLimit.
        const plan = planFill({
          takerSide: "sell",
          takerQtyPendingCent: takerQty,
          takerLimitPriceCents: randIntInclusive(rng, 1, buyLimit),
          passiveQtyPendingCent: pending,
          passiveLimitPriceCents: buyLimit,
        });
        reserved -= plan.buyerReserveReleaseCents;
        expect(reserved).toBeGreaterThanOrEqual(0);
        pending = plan.passiveQtyPendingAfterCent;
      }
      // Fill total: la reserva del comprador cierra EXACTAMENTE en 0 (§5).
      expect(reserved).toBe(0);
    }
  });
});

describe("cappedFeeCents", () => {
  test("cap por available: min(fee ideal, available)", () => {
    expect(cappedFeeCents(11, 100)).toBe(11);
    expect(cappedFeeCents(11, 11)).toBe(11);
    expect(cappedFeeCents(11, 7)).toBe(7);
    expect(cappedFeeCents(11, 0)).toBe(0);
  });
});

describe("buyerLotUnitCostCents", () => {
  test("unit_cost = unitCostFromTotal(cost + fee, qty) — floor por unidad entera", () => {
    // cost 999 + fee 1 = 1000 centavos por 1.00 unidad (100 qtyCent) ⇒ 1000/unidad.
    expect(buyerLotUnitCostCents(999, 1, 100)).toBe(1000);
    // 1000 centavos por 3.00 unidades ⇒ floor(1000/3) = 333.
    expect(buyerLotUnitCostCents(1000, 0, 300)).toBe(333);
  });
});
