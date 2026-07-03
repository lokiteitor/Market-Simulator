import { describe, expect, test } from "bun:test";
import {
  mapProblemToOrderErrors,
  requiredCapitalCents,
  TTL_MAX_SIM_SECONDS,
  TTL_MIN_SIM_SECONDS,
  validateOrderDraft,
  type OrderDraft,
  type OrderValidationContext,
} from "../../src/pages/market/orderValidation";
import type { Problem } from "../../src/api/types";

const ctx: OrderValidationContext = {
  capitalAvailableCents: 100_000, // $1,000.00
  inventoryAvailableCent: 5_000, // 50.00 kg
  unit: "kg",
};

function draft(overrides: Partial<OrderDraft>): OrderDraft {
  return {
    side: "buy",
    qtyInput: "10",
    priceInput: "5.50",
    ttlSimSeconds: 3_600,
    ...overrides,
  };
}

describe("requiredCapitalCents", () => {
  test("qty (centésimas) × precio (centavos) / 100", () => {
    // 10.00 unidades × $5.50 = $55.00
    expect(requiredCapitalCents(1_000, 550)).toBe(5_500);
    // 0.01 unidades × $0.01 = $0.0001 → hacia arriba: 1 centavo
    expect(requiredCapitalCents(1, 1)).toBe(1);
  });

  test("redondea hacia ARRIBA (conservador)", () => {
    // 1.50 × $3.33 = 499.5 centavos → 500
    expect(requiredCapitalCents(150, 333)).toBe(500);
  });
});

describe("validateOrderDraft — parseo de campos", () => {
  test("borrador válido → values parseados y sin errores", () => {
    const { errors, values } = validateOrderDraft(draft({}), ctx);
    expect(errors).toEqual({});
    expect(values).toEqual({
      qty_cent: 1_000,
      limit_price_cents: 550,
      ttl_seconds: 3_600,
    });
  });

  test("cantidad inválida (texto, negativos, >2 decimales, vacía, cero)", () => {
    for (const qtyInput of ["abc", "-5", "1.234", "", "0"]) {
      const { errors, values } = validateOrderDraft(draft({ qtyInput }), ctx);
      expect(errors.qty).toBeDefined();
      expect(values).toBeNull();
    }
  });

  test("precio inválido (texto, cero)", () => {
    for (const priceInput of ["x", "0", "0.00"]) {
      const { errors, values } = validateOrderDraft(draft({ priceInput }), ctx);
      expect(errors.price).toBeDefined();
      expect(values).toBeNull();
    }
  });

  test("acepta $ inicial y comas de millares en el precio", () => {
    const { errors, values } = validateOrderDraft(
      draft({ priceInput: "$1,234.56", qtyInput: "1" }),
      null,
    );
    expect(errors).toEqual({});
    expect(values?.limit_price_cents).toBe(123_456);
  });
});

describe("validateOrderDraft — TTL simulado", () => {
  test("límites inclusive [60, 604800]", () => {
    expect(
      validateOrderDraft(draft({ ttlSimSeconds: TTL_MIN_SIM_SECONDS }), ctx)
        .errors.ttl,
    ).toBeUndefined();
    expect(
      validateOrderDraft(draft({ ttlSimSeconds: TTL_MAX_SIM_SECONDS }), ctx)
        .errors.ttl,
    ).toBeUndefined();
  });

  test("fuera de rango o no entero → error", () => {
    for (const ttl of [0, 59, 604_801, 3_600.5, Number.NaN]) {
      const { errors, values } = validateOrderDraft(
        draft({ ttlSimSeconds: ttl }),
        ctx,
      );
      expect(errors.ttl).toBeDefined();
      expect(values).toBeNull();
    }
  });
});

describe("validateOrderDraft — capital (compra)", () => {
  test("capital justo alcanza", () => {
    // 100.00 × $10.00 = $1,000.00 = capital exacto
    const { errors } = validateOrderDraft(
      draft({ qtyInput: "100", priceInput: "10" }),
      ctx,
    );
    expect(errors.form).toBeUndefined();
  });

  test("capital insuficiente → error de formulario", () => {
    const { errors, values } = validateOrderDraft(
      draft({ qtyInput: "100.01", priceInput: "10" }),
      ctx,
    );
    expect(errors.form).toContain("Capital insuficiente");
    expect(values).toBeNull();
  });

  test("sin self-state (ctx null) no valida capital", () => {
    const { errors } = validateOrderDraft(
      draft({ qtyInput: "999999", priceInput: "999999" }),
      null,
    );
    expect(errors.form).toBeUndefined();
  });
});

describe("validateOrderDraft — inventario (venta)", () => {
  test("inventario justo alcanza", () => {
    const { errors } = validateOrderDraft(
      draft({ side: "sell", qtyInput: "50" }),
      ctx,
    );
    expect(errors.qty).toBeUndefined();
  });

  test("inventario insuficiente → error en cantidad", () => {
    const { errors, values } = validateOrderDraft(
      draft({ side: "sell", qtyInput: "50.01" }),
      ctx,
    );
    expect(errors.qty).toContain("Inventario insuficiente");
    expect(values).toBeNull();
  });

  test("la venta no exige capital", () => {
    const poor: OrderValidationContext = { ...ctx, capitalAvailableCents: 0 };
    const { errors } = validateOrderDraft(
      draft({ side: "sell", qtyInput: "10", priceInput: "100000" }),
      poor,
    );
    expect(errors).toEqual({});
  });
});

describe("mapProblemToOrderErrors", () => {
  const problem: Problem = {
    type: "https://errors.mercado-agricola/validation",
    title: "Validación de dominio falló",
    status: 422,
    errors: [
      { code: "invalid_qty", field: "qty_cent", message: "Cantidad fuera de rango." },
      { code: "insufficient_capital", field: null, message: "Capital insuficiente." },
      { code: "unknown_thing", field: null, message: "Otra causa." },
      { code: "invalid_ttl", field: "ttl_seconds", message: "TTL inválido." },
    ],
  };

  test("mapea por field y por código de dominio; el resto queda sin asignar", () => {
    const { fields, unassigned } = mapProblemToOrderErrors(problem);
    expect(fields.qty).toBe("Cantidad fuera de rango.");
    expect(fields.form).toBe("Capital insuficiente.");
    expect(fields.ttl).toBe("TTL inválido.");
    expect(fields.price).toBeUndefined();
    expect(unassigned).toHaveLength(1);
    expect(unassigned[0]?.code).toBe("unknown_thing");
  });

  test("concatena mensajes múltiples del mismo campo", () => {
    const multi: Problem = {
      ...problem,
      errors: [
        { code: "a", field: "limit_price_cents", message: "Uno." },
        { code: "b", field: "price", message: "Dos." },
      ],
    };
    const { fields, unassigned } = mapProblemToOrderErrors(multi);
    expect(fields.price).toBe("Uno. Dos.");
    expect(unassigned).toHaveLength(0);
  });

  test("problem sin errors[] → nada mapeado", () => {
    const bare: Problem = { type: "about:blank", title: "x", status: 422 };
    const { fields, unassigned } = mapProblemToOrderErrors(bare);
    expect(Object.keys(fields)).toHaveLength(0);
    expect(unassigned).toHaveLength(0);
  });
});
