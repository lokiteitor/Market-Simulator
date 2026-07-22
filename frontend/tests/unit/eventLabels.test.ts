/**
 * eventLabels.test.ts — etiquetas y resúmenes del historial para los tipos de
 * evento del backend, incluidos los de banco, yacimientos, ciudades e
 * instalaciones (ADR-020/021/023).
 */
import { describe, expect, test } from "bun:test";

import {
  eventTypeBadge,
  eventTypeLabel,
  summarizeEventPayload,
} from "../../src/pages/history/eventLabels";

const productName = (id: string): string =>
  id === "p-oro" ? "Oro" : id.slice(0, 8);

describe("eventTypeLabel / eventTypeBadge", () => {
  test("tipos nuevos con etiqueta y badge", () => {
    expect(eventTypeLabel("gold_converted")).toBe("Conversión de oro");
    expect(eventTypeLabel("money_issued")).toBe("Emisión de dinero");
    expect(eventTypeLabel("deposit_depleted")).toBe("Yacimiento agotado");
    expect(eventTypeLabel("city_income_distributed")).toBe(
      "Ingreso urbano repartido",
    );
    expect(eventTypeLabel("installation_purchased")).toBe(
      "Instalación comprada",
    );

    expect(eventTypeBadge("gold_converted")).toBe("completed");
    expect(eventTypeBadge("deposit_depleted")).toBe("expired");
    expect(eventTypeBadge("city_income_distributed")).toBe("active");
  });

  test("fallback para tipos desconocidos en runtime", () => {
    expect(eventTypeLabel("future_event")).toBe("future_event");
    expect(eventTypeBadge("future_event")).toBe("neutral");
  });
});

describe("summarizeEventPayload", () => {
  test("gold_converted: dirección traducida y montos formateados", () => {
    const summary = summarizeEventPayload(
      {
        direction: "sell_gold",
        qty_cent: 1000,
        price_cents_per_unit: 820,
        total_cents: 8200,
      },
      productName,
    );
    expect(summary).toContain("dirección: venta de oro");
    expect(summary).toContain("precio unitario: $8.20");
    expect(summary).toContain("total: $82.00");
  });

  test("city_income_distributed: total y nº de ciudades", () => {
    const summary = summarizeEventPayload(
      { total_cents: 123456, city_count: 50 },
      productName,
    );
    expect(summary).toContain("total: $1,234.56");
    expect(summary).toContain("ciudades: 50");
  });

  test("deposit_depleted: producto resuelto y tamaño inicial", () => {
    const summary = summarizeEventPayload(
      { product_id: "p-oro", qty_initial_cent: 500000 },
      productName,
    );
    expect(summary).toContain("producto: Oro");
    expect(summary).toContain("tamaño inicial: 5,000.00");
  });

  test("installation_purchased: nivel e importe cobrado", () => {
    const summary = summarizeEventPayload(
      { installation_type: "generacion", level: 2, amount_charged_cents: 85000 },
      productName,
    );
    expect(summary).toContain("instalación: generacion");
    expect(summary).toContain("nivel: 2");
    expect(summary).toContain("importe cobrado: $850.00");
  });

  test("payload sin nada resumible → em dash", () => {
    expect(summarizeEventPayload({ nested: { a: 1 } }, productName)).toBe("—");
  });
});
