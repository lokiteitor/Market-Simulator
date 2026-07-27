/**
 * inventoryMath.ts — agregación y valoración del inventario a partir de los
 * lotes FIFO (`GET /agents/me/inventory/lots`). Lógica pura y testeable: la
 * página solo pinta lo que sale de aquí.
 *
 * Convención de unidades (igual que el backend): las cantidades están en
 * centésimas de unidad y los costes en centavos por unidad, así que el valor
 * de un lote es `qty_cent × unit_cost_cents / 100` y vuelve a ser centavos.
 */
import type { InventoryLot } from "../../api/types";

/** Posición agregada por producto, con su detalle de lotes. */
export interface ProductPosition {
  product_id: string;
  qty_available_cent: number;
  qty_reserved_cent: number;
  qty_total_cent: number;
  /** Valor a coste FIFO, en centavos. */
  value_cents: number;
  /** Coste unitario medio ponderado, en centavos por unidad. */
  avg_unit_cost_cents: number;
  /** Lotes del producto en orden FIFO real (acquired_at ascendente). */
  lots: InventoryLot[];
}

export interface InventoryTotals {
  value_cents: number;
  product_count: number;
  lot_count: number;
  /** Porción reservada del inventario en puntos básicos (0..10000). */
  reserved_bps: number;
}

/** Valor a coste de un lote (disponible + reservado), en centavos. */
export function lotValueCents(lot: InventoryLot): number {
  return Math.round(
    ((lot.qty_available_cent + lot.qty_reserved_cent) * lot.unit_cost_cents) /
      100,
  );
}

/**
 * Valor total del inventario en centavos.
 * (Vive aquí para que dashboard e inventario compartan una sola fórmula.)
 */
export function estimateInventoryValueCents(
  lots: readonly InventoryLot[],
): number {
  let total = 0;
  for (const lot of lots) total += lotValueCents(lot);
  return total;
}

/** Timestamp ordenable de un lote; los inválidos van al final. */
function acquiredAtMs(lot: InventoryLot): number {
  const ms = Date.parse(lot.acquired_at);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Agrupa los lotes por producto. Cada posición trae sus lotes en orden FIFO
 * (el mismo que consumiría el backend) y su coste medio ponderado.
 */
export function groupLotsByProduct(
  lots: readonly InventoryLot[],
): ProductPosition[] {
  const byProduct = new Map<string, ProductPosition>();

  for (const lot of lots) {
    let position = byProduct.get(lot.product_id);
    if (position === undefined) {
      position = {
        product_id: lot.product_id,
        qty_available_cent: 0,
        qty_reserved_cent: 0,
        qty_total_cent: 0,
        value_cents: 0,
        avg_unit_cost_cents: 0,
        lots: [],
      };
      byProduct.set(lot.product_id, position);
    }
    position.qty_available_cent += lot.qty_available_cent;
    position.qty_reserved_cent += lot.qty_reserved_cent;
    position.value_cents += lotValueCents(lot);
    position.lots.push(lot);
  }

  const positions = [...byProduct.values()];
  for (const position of positions) {
    position.qty_total_cent =
      position.qty_available_cent + position.qty_reserved_cent;
    // Media ponderada: valor (centavos) ÷ cantidad (unidades) = centavos/unidad.
    position.avg_unit_cost_cents =
      position.qty_total_cent > 0
        ? Math.round((position.value_cents * 100) / position.qty_total_cent)
        : 0;
    position.lots.sort((a, b) => acquiredAtMs(a) - acquiredAtMs(b));
  }

  // Mayor valor primero: lo relevante encabeza la tabla antes de ordenar.
  positions.sort((a, b) => b.value_cents - a.value_cents);
  return positions;
}

/** KPIs de cabecera a partir de las posiciones ya agregadas. */
export function inventoryTotals(
  positions: readonly ProductPosition[],
): InventoryTotals {
  let value = 0;
  let lotCount = 0;
  let qtyTotal = 0;
  let qtyReserved = 0;

  for (const position of positions) {
    value += position.value_cents;
    lotCount += position.lots.length;
    qtyTotal += position.qty_total_cent;
    qtyReserved += position.qty_reserved_cent;
  }

  return {
    value_cents: value,
    product_count: positions.length,
    lot_count: lotCount,
    reserved_bps:
      qtyTotal > 0 ? Math.round((qtyReserved * 10_000) / qtyTotal) : 0,
  };
}
