/**
 * Servicio de inventario por lotes FIFO (contrato §8, módulo [M5 inventory]).
 *
 * Implementa la interfaz `InventoryService` de src/types/contracts.ts como
 * singleton `inventoryService`.
 *
 * Decisiones vinculantes aplicadas:
 *   - FIFO ESTRICTO: (acquired_at ASC, lot_id ASC) en todo reparto y lectura.
 *   - Las reservas/consumos/liberaciones operan sobre el POOL AGREGADO del
 *     agente por producto: no hay mapeo orden→lote persistido (contrato §8).
 *   - TODAS las operaciones reciben `tx` y NUNCA abren transacción propia
 *     (contrato §0): la atomicidad la aporta la transacción del caller
 *     (order-service, transformation-service, matching, …).
 *   - Insuficiencia SIN mutar (decisión documentada): las operaciones bloquean
 *     los lotes con FOR UPDATE, calculan el reparto con `splitFifo` sobre ese
 *     snapshot bloqueado y VALIDAN EL TOTAL ANTES de emitir cualquier UPDATE.
 *     Si no alcanza, lanzan DomainError(insufficient_inventory) sin haber
 *     tocado ninguna fila: NO se confía en el rollback de la tx del caller
 *     (aunque exista) y el snapshot no puede cambiar bajo nuestros pies porque
 *     las filas ya están bloqueadas.
 *
 * El algoritmo de reparto está extraído como función PURA (`splitFifo`) y
 * testeado sin DB en tests/unit/inventory/fifo.test.ts.
 */
import type { Tx } from "../db";
import { domainError } from "../lib/errors";
import { inventoryRepository } from "../repositories/inventory-repository";
import type { LotDelta, LotPool } from "../repositories/inventory-repository";
import type {
  InventoryLotRow,
  InventoryService,
  LotConsumption,
} from "../types/contracts";

// ---------------------------------------------------------------------------
// Reparto FIFO puro
// ---------------------------------------------------------------------------

/** Vista mínima de un lote para el reparto: cantidad del pool relevante. */
export interface FifoLotInput {
  lotId: string;
  /** Cantidad disponible EN EL POOL sobre el que se reparte (centésimas). */
  qtyCent: number;
  /** Snapshot del costo unitario del lote (centavos por unidad entera). */
  unitCostCents: number;
}

export type FifoSplitResult =
  | { ok: true; allocations: LotConsumption[] }
  | {
      ok: false;
      /** Total del pool (Σ qtyCent de los lotes recibidos). */
      totalCent: number;
      /** Cuánto faltó para cubrir la cantidad solicitada. */
      shortfallCent: number;
    };

/**
 * Reparte `qtyCent` sobre `lots` en el ORDEN RECIBIDO (el caller garantiza el
 * orden FIFO: acquired_at ASC, lot_id ASC). Función PURA: no muta `lots`.
 *
 * - Toma de cada lote min(restante, lote.qtyCent) hasta cubrir la cantidad.
 * - Lotes con qtyCent = 0 se saltan (no generan allocation).
 * - Si Σ lots < qtyCent devuelve { ok: false } con el total y el faltante;
 *   NO devuelve reparto parcial.
 * - qtyCent = 0 ⇒ { ok: true, allocations: [] }.
 * - Lanza Error ante cantidades negativas o no enteras (bug del caller).
 */
export function splitFifo(
  lots: readonly FifoLotInput[],
  qtyCent: number,
): FifoSplitResult {
  if (!Number.isSafeInteger(qtyCent) || qtyCent < 0) {
    throw new Error(
      `splitFifo: qtyCent debe ser un entero seguro >= 0; recibido: ${qtyCent}`,
    );
  }
  const allocations: LotConsumption[] = [];
  let remaining = qtyCent;
  for (const lot of lots) {
    if (!Number.isSafeInteger(lot.qtyCent) || lot.qtyCent < 0) {
      throw new Error(
        `splitFifo: lote ${lot.lotId} con qtyCent inválido: ${lot.qtyCent}`,
      );
    }
    if (remaining === 0) break;
    if (lot.qtyCent === 0) continue;
    const take = Math.min(remaining, lot.qtyCent);
    allocations.push({
      lotId: lot.lotId,
      qtyCent: take,
      unitCostCents: lot.unitCostCents,
    });
    remaining -= take;
  }
  if (remaining > 0) {
    // El loop recorrió todos los lotes: lo asignado equivale al total del pool.
    return { ok: false, totalCent: qtyCent - remaining, shortfallCent: remaining };
  }
  return { ok: true, allocations };
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/**
 * Bloquea los lotes FIFO del pool, calcula el reparto y valida el total ANTES
 * de mutar. Lanza insufficient_inventory sin haber emitido ningún UPDATE.
 *
 * Para el pool "reserved" (releaseReservedFifo / consumeReservedFifo) una
 * insuficiencia indica además una VIOLACIÓN DE INVARIANTE (la reserva agregada
 * debería cubrir siempre lo pendiente de las órdenes de venta activas); se
 * lanza el mismo DomainError para abortar la tx del caller y hacer visible el
 * bug en lugar de liberar/consumir de menos silenciosamente.
 */
async function allocateFifoLocked(
  tx: Tx,
  agentId: string,
  productId: string,
  qtyCent: number,
  pool: LotPool,
): Promise<LotConsumption[]> {
  if (qtyCent === 0) return [];
  const locked = await inventoryRepository.lockFifoLots(tx, agentId, productId, pool);
  const fifoInput: FifoLotInput[] = locked.map((l) => ({
    lotId: l.lotId,
    qtyCent: pool === "available" ? l.qtyAvailable : l.qtyReserved,
    unitCostCents: l.unitCostCents,
  }));
  const split = splitFifo(fifoInput, qtyCent);
  if (!split.ok) {
    const poolName = pool === "available" ? "disponible" : "reservado";
    throw domainError(
      "insufficient_inventory",
      `Inventario ${poolName} insuficiente del producto ${productId}: ` +
        `solicitado ${qtyCent}, en pool ${split.totalCent} (faltan ${split.shortfallCent}).`,
    );
  }
  return split.allocations;
}

/** Traduce allocations a deltas por lote: resta de `from` y suma a `to` (si hay). */
function toDeltas(
  allocations: readonly LotConsumption[],
  from: LotPool,
  to: LotPool | null,
): LotDelta[] {
  return allocations.map((a) => ({
    lotId: a.lotId,
    availableDelta:
      (from === "available" ? -a.qtyCent : 0) + (to === "available" ? a.qtyCent : 0),
    reservedDelta:
      (from === "reserved" ? -a.qtyCent : 0) + (to === "reserved" ? a.qtyCent : 0),
  }));
}

/** Mueve/consume `qtyCent` FIFO del pool `from` (al pool `to`, o consumo si null). */
async function moveFifo(
  tx: Tx,
  agentId: string,
  productId: string,
  qtyCent: number,
  from: LotPool,
  to: LotPool | null,
): Promise<LotConsumption[]> {
  const allocations = await allocateFifoLocked(tx, agentId, productId, qtyCent, from);
  if (allocations.length > 0) {
    await inventoryRepository.applyLotDeltas(tx, toDeltas(allocations, from, to));
  }
  return allocations;
}

/**
 * Espejo en aplicación del CHECK `inventory_lot_check1` del DDL:
 *   purchase   ⇒ source_trade_id NOT NULL y los demás sources NULL
 *   production ⇒ source_process_id NOT NULL y los demás NULL
 *   conversion ⇒ source_conversion_id NOT NULL y los demás NULL
 *   initial    ⇒ todos NULL
 * Una violación es un bug del caller (no un error de dominio del cliente):
 * se lanza Error plano para que el handler global lo trate como 500.
 */
function assertOriginSourceCoherence(p: {
  origin: "initial" | "production" | "purchase" | "conversion";
  sourceTradeId?: string;
  sourceProcessId?: string;
  sourceConversionId?: string;
}): void {
  const hasTrade = p.sourceTradeId !== undefined;
  const hasProcess = p.sourceProcessId !== undefined;
  const hasConversion = p.sourceConversionId !== undefined;
  const valid =
    (p.origin === "purchase" && hasTrade && !hasProcess && !hasConversion) ||
    (p.origin === "production" && hasProcess && !hasTrade && !hasConversion) ||
    (p.origin === "conversion" && hasConversion && !hasTrade && !hasProcess) ||
    (p.origin === "initial" && !hasTrade && !hasProcess && !hasConversion);
  if (!valid) {
    throw new Error(
      `createLot: origen '${p.origin}' incoherente con sources ` +
        `(sourceTradeId=${p.sourceTradeId ?? "null"}, sourceProcessId=${p.sourceProcessId ?? "null"}, ` +
        `sourceConversionId=${p.sourceConversionId ?? "null"})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Singleton InventoryService (contrato §8)
// ---------------------------------------------------------------------------

export const inventoryService: InventoryService = {
  async createLot(
    tx: Tx,
    p: {
      agentId: string;
      productId: string;
      origin: "initial" | "production" | "purchase" | "conversion";
      qtyCent: number;
      unitCostCents: number;
      sourceTradeId?: string;
      sourceProcessId?: string;
      sourceConversionId?: string;
    },
  ): Promise<string> {
    assertOriginSourceCoherence(p);
    if (!Number.isSafeInteger(p.qtyCent) || p.qtyCent <= 0) {
      // Espejo del CHECK qty_original > 0 del DDL.
      throw new Error(`createLot: qtyCent debe ser entero > 0; recibido: ${p.qtyCent}`);
    }
    if (!Number.isSafeInteger(p.unitCostCents) || p.unitCostCents < 0) {
      // Espejo del CHECK unit_cost_cents >= 0 del DDL.
      throw new Error(
        `createLot: unitCostCents debe ser entero >= 0; recibido: ${p.unitCostCents}`,
      );
    }
    return inventoryRepository.insertLot(tx, {
      agentId: p.agentId,
      productId: p.productId,
      origin: p.origin,
      qtyCent: p.qtyCent,
      unitCostCents: p.unitCostCents,
      sourceTradeId: p.sourceTradeId ?? null,
      sourceProcessId: p.sourceProcessId ?? null,
      sourceConversionId: p.sourceConversionId ?? null,
    });
  },

  /** available → reserved, FIFO. Lanza insufficient_inventory SIN mutar. */
  async reserveFifo(
    tx: Tx,
    agentId: string,
    productId: string,
    qtyCent: number,
  ): Promise<void> {
    await moveFifo(tx, agentId, productId, qtyCent, "available", "reserved");
  },

  /** reserved → available, FIFO (cancelación/expiración/cierre de orden de venta). */
  async releaseReservedFifo(
    tx: Tx,
    agentId: string,
    productId: string,
    qtyCent: number,
  ): Promise<void> {
    await moveFifo(tx, agentId, productId, qtyCent, "reserved", "available");
  },

  /**
   * Consume del pool reservado (ejecución de trade del lado vendedor), FIFO.
   * Devuelve el detalle por lote con unit_cost_cents SNAPSHOT para que el
   * caller persista trade_lot_consumption (COGS).
   */
  async consumeReservedFifo(
    tx: Tx,
    agentId: string,
    productId: string,
    qtyCent: number,
  ): Promise<LotConsumption[]> {
    return moveFifo(tx, agentId, productId, qtyCent, "reserved", null);
  },

  /**
   * Consume del pool disponible (insumos al iniciar transformación), FIFO.
   * Lanza insufficient_inventory SIN mutar. Devuelve el detalle por lote con
   * unit_cost_cents snapshot (transformation_lot_consumption).
   */
  async consumeAvailableFifo(
    tx: Tx,
    agentId: string,
    productId: string,
    qtyCent: number,
  ): Promise<LotConsumption[]> {
    return moveFifo(tx, agentId, productId, qtyCent, "available", null);
  },

  /** Posición agregada por producto (excluye posiciones totalmente en cero). */
  async getPositions(
    tx: Tx,
    agentId: string,
  ): Promise<Array<{ productId: string; qtyAvailable: number; qtyReserved: number }>> {
    return inventoryRepository.selectPositions(tx, agentId);
  },

  /**
   * Lotes del agente en orden FIFO, opcionalmente por producto. Incluye lotes
   * agotados: el filtro `only_with_stock` del openapi es responsabilidad del
   * controller.
   */
  async getLots(
    tx: Tx,
    agentId: string,
    productId?: string,
  ): Promise<InventoryLotRow[]> {
    return inventoryRepository.selectLots(tx, agentId, productId);
  },

  /** Σ available+reserved de todos los lotes del agente (condición de quiebra §8). */
  async getTotalInventory(tx: Tx, agentId: string): Promise<number> {
    return inventoryRepository.selectTotalInventory(tx, agentId);
  },
};
