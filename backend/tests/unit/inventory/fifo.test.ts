/**
 * Tests PUROS del algoritmo de reparto FIFO (splitFifo) del módulo
 * [M5 inventory]. Sin DB: splitFifo es una función pura; el service la aplica
 * sobre lotes bloqueados con FOR UPDATE en orden (acquired_at ASC, lot_id ASC).
 */
import { describe, expect, test } from "bun:test";

import { splitFifo } from "../../../src/services/inventory-service";
import type { FifoLotInput } from "../../../src/services/inventory-service";

function lot(lotId: string, qtyCent: number, unitCostCents: number): FifoLotInput {
  return { lotId, qtyCent, unitCostCents };
}

describe("splitFifo — reparto exacto", () => {
  test("un solo lote cubre exacto la cantidad", () => {
    const result = splitFifo([lot("a", 100, 250)], 100);
    expect(result).toEqual({
      ok: true,
      allocations: [{ lotId: "a", qtyCent: 100, unitCostCents: 250 }],
    });
  });

  test("toma parcialmente del primer lote y no toca los siguientes", () => {
    const result = splitFifo([lot("a", 100, 250), lot("b", 100, 300)], 40);
    expect(result).toEqual({
      ok: true,
      allocations: [{ lotId: "a", qtyCent: 40, unitCostCents: 250 }],
    });
  });

  test("cruza varios lotes en el orden recibido (FIFO)", () => {
    const result = splitFifo(
      [lot("a", 50, 100), lot("b", 30, 200), lot("c", 100, 300)],
      100,
    );
    expect(result).toEqual({
      ok: true,
      allocations: [
        { lotId: "a", qtyCent: 50, unitCostCents: 100 },
        { lotId: "b", qtyCent: 30, unitCostCents: 200 },
        { lotId: "c", qtyCent: 20, unitCostCents: 300 },
      ],
    });
  });

  test("drena exactamente el total de todos los lotes", () => {
    const result = splitFifo([lot("a", 50, 100), lot("b", 50, 200)], 100);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.allocations.map((a) => a.qtyCent)).toEqual([50, 50]);
    }
  });

  test("la suma de allocations es exactamente la cantidad pedida", () => {
    const lots = [lot("a", 33, 10), lot("b", 77, 20), lot("c", 15, 30), lot("d", 260, 40)];
    const result = splitFifo(lots, 300);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const total = result.allocations.reduce((acc, a) => acc + a.qtyCent, 0);
      expect(total).toBe(300);
    }
  });
});

describe("splitFifo — snapshot de costos", () => {
  test("cada allocation lleva el unit_cost_cents de SU lote (snapshot)", () => {
    const result = splitFifo([lot("viejo", 10, 111), lot("nuevo", 10, 999)], 15);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.allocations).toEqual([
        { lotId: "viejo", qtyCent: 10, unitCostCents: 111 },
        { lotId: "nuevo", qtyCent: 5, unitCostCents: 999 },
      ]);
    }
  });

  test("costo unitario 0 es válido (lotes gratuitos, p. ej. iniciales)", () => {
    const result = splitFifo([lot("a", 10, 0)], 10);
    expect(result).toEqual({
      ok: true,
      allocations: [{ lotId: "a", qtyCent: 10, unitCostCents: 0 }],
    });
  });
});

describe("splitFifo — lotes vacíos y bordes", () => {
  test("salta lotes con cantidad 0 sin generar allocations", () => {
    const result = splitFifo(
      [lot("vacio1", 0, 100), lot("a", 60, 200), lot("vacio2", 0, 300), lot("b", 40, 400)],
      80,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.allocations).toEqual([
        { lotId: "a", qtyCent: 60, unitCostCents: 200 },
        { lotId: "b", qtyCent: 20, unitCostCents: 400 },
      ]);
    }
  });

  test("cantidad 0 ⇒ ok con reparto vacío", () => {
    expect(splitFifo([lot("a", 100, 250)], 0)).toEqual({ ok: true, allocations: [] });
    expect(splitFifo([], 0)).toEqual({ ok: true, allocations: [] });
  });

  test("no muta el array de entrada ni sus lotes", () => {
    const lots = [lot("a", 50, 100), lot("b", 50, 200)];
    const snapshot = structuredClone(lots);
    splitFifo(lots, 75);
    expect(lots).toEqual(snapshot);
  });
});

describe("splitFifo — insuficiencia (sin reparto parcial)", () => {
  test("sin lotes ⇒ ok:false con total 0 y faltante completo", () => {
    expect(splitFifo([], 100)).toEqual({ ok: false, totalCent: 0, shortfallCent: 100 });
  });

  test("total del pool menor que lo pedido ⇒ ok:false con total y faltante exactos", () => {
    const result = splitFifo([lot("a", 30, 100), lot("b", 20, 200)], 75);
    expect(result).toEqual({ ok: false, totalCent: 50, shortfallCent: 25 });
  });

  test("falta 1 centésima ⇒ ok:false (no hay redondeos tolerantes)", () => {
    const result = splitFifo([lot("a", 99, 100)], 100);
    expect(result).toEqual({ ok: false, totalCent: 99, shortfallCent: 1 });
  });

  test("solo lotes vacíos ⇒ ok:false con total 0", () => {
    const result = splitFifo([lot("a", 0, 100), lot("b", 0, 200)], 10);
    expect(result).toEqual({ ok: false, totalCent: 0, shortfallCent: 10 });
  });
});

describe("splitFifo — validación de argumentos (bugs del caller)", () => {
  test("rechaza cantidad negativa", () => {
    expect(() => splitFifo([lot("a", 10, 100)], -1)).toThrow();
  });

  test("rechaza cantidad no entera", () => {
    expect(() => splitFifo([lot("a", 10, 100)], 1.5)).toThrow();
  });

  test("rechaza lote con cantidad negativa", () => {
    expect(() => splitFifo([lot("a", -5, 100)], 1)).toThrow();
  });

  test("rechaza lote con cantidad no entera", () => {
    expect(() => splitFifo([lot("a", 2.5, 100)], 1)).toThrow();
  });

  test("acepta cantidades grandes dentro de enteros seguros", () => {
    const big = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER
    const result = splitFifo([lot("a", big, 1)], big);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.allocations).toEqual([{ lotId: "a", qtyCent: big, unitCostCents: 1 }]);
    }
  });
});

describe("splitFifo — orden FIFO respetado", () => {
  test("las allocations salen en el mismo orden que los lotes de entrada", () => {
    // El caller (repositorio) garantiza acquired_at ASC, lot_id ASC; splitFifo
    // NO reordena: consume estrictamente en el orden recibido.
    const lots = [lot("l3", 10, 5), lot("l1", 10, 9), lot("l2", 10, 1)];
    const result = splitFifo(lots, 30);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.allocations.map((a) => a.lotId)).toEqual(["l3", "l1", "l2"]);
    }
  });
});
