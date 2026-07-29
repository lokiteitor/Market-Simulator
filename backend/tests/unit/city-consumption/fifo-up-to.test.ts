/**
 * Tests puros del reparto FIFO BEST-EFFORT que usa el consumo urbano (ADR-029).
 *
 * `splitFifo` es todo-o-nada: o cubre la cantidad pedida o no reparte nada. El
 * consumo urbano necesita lo contrario (consumir lo que haya y anotar el resto
 * como déficit), y lo consigue pidiendo `min(pedido, total del pool)`. Aquí se
 * verifica esa composición sobre la función pura, sin DB: si `splitFifo` dejara
 * de cumplir el contrato, el sweeper consumiría de menos en silencio.
 */
import { describe, expect, test } from "bun:test";
import { splitFifo, type FifoLotInput } from "../../../src/services/inventory-service";

/** Lo que hace `allocateFifoLockedUpTo`: acotar la petición al pool disponible. */
function splitFifoUpTo(lots: readonly FifoLotInput[], qtyCent: number) {
  const total = lots.reduce((s, l) => s + l.qtyCent, 0);
  return splitFifo(lots, Math.min(qtyCent, total));
}

const lote = (id: string, qtyCent: number, unitCostCents = 100): FifoLotInput => ({
  lotId: id,
  qtyCent,
  unitCostCents,
});

const consumido = (r: ReturnType<typeof splitFifo>): number =>
  r.ok ? r.allocations.reduce((s, a) => s + a.qtyCent, 0) : -1;

describe("consumo FIFO best-effort (min(pedido, pool))", () => {
  test("con stock de sobra consume exactamente lo pedido", () => {
    const r = splitFifoUpTo([lote("a", 1000)], 300);
    expect(r.ok).toBe(true);
    expect(consumido(r)).toBe(300);
  });

  test("con stock JUSTO consume todo el pool", () => {
    const r = splitFifoUpTo([lote("a", 300)], 300);
    expect(consumido(r)).toBe(300);
  });

  test("con stock PARCIAL consume lo que hay, no falla (déficit del modelo)", () => {
    // El caso que `consumeAvailableFifo` no cubriría: pediría 300, habría 120 y
    // no consumiría NADA, dejando el inventario intacto pasada tras pasada.
    const r = splitFifoUpTo([lote("a", 120)], 300);
    expect(r.ok).toBe(true);
    expect(consumido(r)).toBe(120);
  });

  test("SIN stock devuelve un reparto vacío, no un error", () => {
    const r = splitFifoUpTo([], 300);
    expect(r.ok).toBe(true);
    expect(consumido(r)).toBe(0);
  });

  test("sin stock aunque haya lotes agotados (0/0) en la lista", () => {
    const r = splitFifoUpTo([lote("a", 0), lote("b", 0)], 300);
    expect(consumido(r)).toBe(0);
  });

  test("consume en ORDEN FIFO a través de varios lotes", () => {
    const r = splitFifoUpTo([lote("viejo", 100), lote("medio", 100), lote("nuevo", 100)], 250);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.allocations).toEqual([
      { lotId: "viejo", qtyCent: 100, unitCostCents: 100 },
      { lotId: "medio", qtyCent: 100, unitCostCents: 100 },
      { lotId: "nuevo", qtyCent: 50, unitCostCents: 100 },
    ]);
  });

  test("multi-lote con stock parcial: vacía todos y no revienta", () => {
    const r = splitFifoUpTo([lote("a", 40), lote("b", 30)], 1000);
    expect(consumido(r)).toBe(70);
  });

  test("arrastra el coste unitario snapshot de cada lote", () => {
    // El consumo urbano no persiste trazabilidad de coste, pero el reparto sí lo
    // expone: es lo que permitiría valorar la cesta destruida si se necesitara.
    const r = splitFifoUpTo([lote("caro", 50, 900), lote("barato", 50, 100)], 80);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.allocations.map((a) => a.unitCostCents)).toEqual([900, 100]);
  });

  test("pedir el máximo entero seguro equivale a vaciar el pool (absorber vivienda)", () => {
    // Es exactamente cómo el sweeper absorbe TODA la vivienda disponible.
    const r = splitFifoUpTo([lote("a", 100), lote("b", 200)], Number.MAX_SAFE_INTEGER);
    expect(consumido(r)).toBe(300);
  });

  test("pedir 0 no consume nada", () => {
    const r = splitFifoUpTo([lote("a", 100)], 0);
    expect(consumido(r)).toBe(0);
  });
});
