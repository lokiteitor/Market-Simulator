import { describe, expect, test } from "bun:test";
import {
  addFill,
  digestToast,
  emptyDigest,
  FILL_DIGEST_WINDOW_MS,
} from "../../src/ws/fillDigest";

describe("addFill", () => {
  test("acumula cantidad y nocional", () => {
    // 10.00 unidades a $5.00 = $50.00
    const digest = addFill(emptyDigest(), {
      qty_executed_cent: 1_000,
      price_cents: 500,
    });
    expect(digest).toEqual({ count: 1, qtyCent: 1_000, notionalCents: 5_000 });
  });

  test("varios fills se suman", () => {
    let digest = emptyDigest();
    digest = addFill(digest, { qty_executed_cent: 1_000, price_cents: 500 });
    digest = addFill(digest, { qty_executed_cent: 500, price_cents: 200 });
    expect(digest).toEqual({ count: 2, qtyCent: 1_500, notionalCents: 6_000 });
  });

  test("nocional con floor (aritmética entera del backend)", () => {
    // 1.50 × $3.33 = 499.5 centavos → 499
    const digest = addFill(emptyDigest(), {
      qty_executed_cent: 150,
      price_cents: 333,
    });
    expect(digest.notionalCents).toBe(499);
  });

  test("acepta qty_cent como alias de qty_executed_cent", () => {
    const digest = addFill(emptyDigest(), { qty_cent: 200, price_cents: 100 });
    expect(digest).toEqual({ count: 1, qtyCent: 200, notionalCents: 200 });
  });

  test("payload sin cifras: solo incrementa el contador", () => {
    const digest = addFill(emptyDigest(), { order_id: "abc" });
    expect(digest).toEqual({ count: 1, qtyCent: 0, notionalCents: 0 });
  });

  test("campos no numéricos se ignoran", () => {
    const digest = addFill(emptyDigest(), {
      qty_executed_cent: "1000",
      price_cents: null,
    });
    expect(digest).toEqual({ count: 1, qtyCent: 0, notionalCents: 0 });
  });

  test("no muta el acumulado recibido", () => {
    const base = emptyDigest();
    addFill(base, { qty_executed_cent: 1_000, price_cents: 500 });
    expect(base).toEqual({ count: 0, qtyCent: 0, notionalCents: 0 });
  });
});

describe("digestToast", () => {
  test("sin fills → sin toast", () => {
    expect(digestToast(emptyDigest())).toBeNull();
  });

  test("un solo fill conserva el detalle", () => {
    const toast = digestToast(
      addFill(emptyDigest(), { qty_executed_cent: 1_000, price_cents: 500 }),
    );
    expect(toast?.title).toBe("Orden ejecutada");
    expect(toast?.body).toContain("10.00");
    expect(toast?.body).toContain("$50.00");
  });

  test("un fill sin cifras degrada a mensaje genérico", () => {
    const toast = digestToast(addFill(emptyDigest(), {}));
    expect(toast?.body).toBe("Una de tus órdenes se ejecutó.");
  });

  test("varios fills → resumen con el total de la ventana", () => {
    let digest = emptyDigest();
    digest = addFill(digest, { qty_executed_cent: 1_000, price_cents: 500 });
    digest = addFill(digest, { qty_executed_cent: 500, price_cents: 200 });
    digest = addFill(digest, { qty_executed_cent: 500, price_cents: 200 });

    const toast = digestToast(digest);
    expect(toast?.title).toBe("3 ejecuciones de tus órdenes");
    expect(toast?.body).toContain("20.00");
    expect(toast?.body).toContain("$70.00");
    expect(toast?.body).toContain(`${FILL_DIGEST_WINDOW_MS / 1000} s`);
  });

  test("siempre es un toast de éxito", () => {
    expect(digestToast(addFill(emptyDigest(), {}))?.kind).toBe("success");
  });
});
