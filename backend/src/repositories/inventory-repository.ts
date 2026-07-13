/**
 * Repositorio de lotes de inventario (contrato §8, módulo [M5 inventory]).
 *
 * Reglas de acceso a datos:
 *   - FIFO ESTRICTO: toda lectura orientada a consumo/reserva/liberación ordena
 *     por (acquired_at ASC, lot_id ASC). lot_id es uuidv7, así que desempata por
 *     tiempo de creación cuando dos lotes comparten acquired_at.
 *   - Las operaciones de mutación bloquean primero las filas con FOR UPDATE
 *     (`lockFifoLots`) y solo después aplican los deltas (`applyLotDeltas`).
 *   - Recibe SIEMPRE `tx` como primer parámetro; NUNCA abre transacciones
 *     propias (contrato §0). Las transacciones las abren los services callers
 *     (order-service, transformation-service, …) con `withTransaction`.
 *
 * Nota sobre FOR UPDATE + ORDER BY: todas las mutaciones del pool de un
 * (agente, producto) pasan por flujos ya serializados aguas arriba (lock de
 * producto en órdenes §10.2; FOR UPDATE de la fila de agente en procesos
 * §10.4), por lo que el orden de adquisición de locks de lote es estable y no
 * introduce deadlocks entre estos flujos.
 */
import { and, asc, eq, gt, sql } from "drizzle-orm";

import type { Tx } from "../db";
import { inventoryLot } from "../db/schema";
import type { InventoryLotRow } from "../db/schema";

/** Pool de un lote sobre el que opera una mutación FIFO. */
export type LotPool = "available" | "reserved";

/** Fila mínima bloqueada (FOR UPDATE) para el reparto FIFO. */
export interface LockedLot {
  lotId: string;
  qtyAvailable: number;
  qtyReserved: number;
  unitCostCents: number;
}

/** Delta a aplicar sobre un lote ya bloqueado. */
export interface LotDelta {
  lotId: string;
  availableDelta: number;
  reservedDelta: number;
}

/** Posición agregada por producto. */
export interface PositionRow {
  productId: string;
  qtyAvailable: number;
  qtyReserved: number;
}

export const inventoryRepository = {
  /**
   * Inserta un lote nuevo (qty_available = qty_original, qty_reserved = 0)
   * y devuelve su lot_id. La coherencia origin↔source la valida el service
   * (espejo del CHECK `inventory_lot_check1` del DDL).
   */
  async insertLot(
    tx: Tx,
    p: {
      agentId: string;
      productId: string;
      origin: "initial" | "production" | "purchase" | "conversion";
      qtyCent: number;
      unitCostCents: number;
      sourceTradeId: string | null;
      sourceProcessId: string | null;
      sourceConversionId: string | null;
    },
  ): Promise<string> {
    const rows = await tx
      .insert(inventoryLot)
      .values({
        agentId: p.agentId,
        productId: p.productId,
        origin: p.origin,
        qtyOriginal: p.qtyCent,
        qtyAvailable: p.qtyCent,
        qtyReserved: 0,
        unitCostCents: p.unitCostCents,
        sourceTradeId: p.sourceTradeId,
        sourceProcessId: p.sourceProcessId,
        sourceConversionId: p.sourceConversionId,
      })
      .returning({ lotId: inventoryLot.lotId });
    const row = rows[0];
    if (row === undefined) {
      // INSERT ... RETURNING siempre devuelve la fila; solo un fallo del driver
      // llega aquí.
      throw new Error("inventory_lot insert returned no rows");
    }
    return row.lotId;
  },

  /**
   * Bloquea (FOR UPDATE) los lotes del (agente, producto) con cantidad > 0 en
   * el pool indicado, en orden FIFO ESTRICTO (acquired_at ASC, lot_id ASC).
   * Devuelve el snapshot bloqueado sobre el que se calcula el reparto.
   */
  async lockFifoLots(
    tx: Tx,
    agentId: string,
    productId: string,
    pool: LotPool,
  ): Promise<LockedLot[]> {
    const poolColumn =
      pool === "available" ? inventoryLot.qtyAvailable : inventoryLot.qtyReserved;
    return tx
      .select({
        lotId: inventoryLot.lotId,
        qtyAvailable: inventoryLot.qtyAvailable,
        qtyReserved: inventoryLot.qtyReserved,
        unitCostCents: inventoryLot.unitCostCents,
      })
      .from(inventoryLot)
      .where(
        and(
          eq(inventoryLot.agentId, agentId),
          eq(inventoryLot.productId, productId),
          gt(poolColumn, 0),
        ),
      )
      .orderBy(asc(inventoryLot.acquiredAt), asc(inventoryLot.lotId))
      .for("update");
  },

  /**
   * Aplica deltas relativos sobre lotes previamente bloqueados con
   * `lockFifoLots`. Los CHECKs del DDL (qty_* >= 0, available+reserved <=
   * original) actúan como última línea de defensa; el service garantiza que
   * los deltas calculados sobre el snapshot bloqueado nunca los violan.
   */
  async applyLotDeltas(tx: Tx, deltas: readonly LotDelta[]): Promise<void> {
    for (const d of deltas) {
      await tx
        .update(inventoryLot)
        .set({
          qtyAvailable: sql`${inventoryLot.qtyAvailable} + ${d.availableDelta}`,
          qtyReserved: sql`${inventoryLot.qtyReserved} + ${d.reservedDelta}`,
        })
        .where(eq(inventoryLot.lotId, d.lotId));
    }
  },

  /**
   * Posiciones agregadas por producto del agente (Σ available, Σ reserved
   * sobre sus lotes). Excluye posiciones totalmente en cero (lotes agotados):
   * "no tener posición" y "posición 0/0" son equivalentes para los lectores.
   */
  async selectPositions(tx: Tx, agentId: string): Promise<PositionRow[]> {
    return tx
      .select({
        productId: inventoryLot.productId,
        qtyAvailable: sql<number>`coalesce(sum(${inventoryLot.qtyAvailable}), 0)`.mapWith(
          Number,
        ),
        qtyReserved: sql<number>`coalesce(sum(${inventoryLot.qtyReserved}), 0)`.mapWith(
          Number,
        ),
      })
      .from(inventoryLot)
      .where(eq(inventoryLot.agentId, agentId))
      .groupBy(inventoryLot.productId)
      .having(
        sql`sum(${inventoryLot.qtyAvailable}) + sum(${inventoryLot.qtyReserved}) > 0`,
      )
      .orderBy(asc(inventoryLot.productId));
  },

  /**
   * Lotes del agente en orden FIFO (acquired_at ASC, lot_id ASC), opcionalmente
   * filtrados por producto. Devuelve TODOS los lotes, incluidos los agotados:
   * el filtro `only_with_stock` del openapi lo aplica el controller que expone
   * `/agents/me/inventory/lots`.
   */
  async selectLots(
    tx: Tx,
    agentId: string,
    productId?: string,
  ): Promise<InventoryLotRow[]> {
    const conditions = [eq(inventoryLot.agentId, agentId)];
    if (productId !== undefined) {
      conditions.push(eq(inventoryLot.productId, productId));
    }
    return tx
      .select()
      .from(inventoryLot)
      .where(and(...conditions))
      .orderBy(asc(inventoryLot.acquiredAt), asc(inventoryLot.lotId));
  },

  /** Σ (qty_available + qty_reserved) de todos los lotes del agente. */
  async selectTotalInventory(tx: Tx, agentId: string): Promise<number> {
    const rows = await tx
      .select({
        total: sql<number>`coalesce(sum(${inventoryLot.qtyAvailable} + ${inventoryLot.qtyReserved}), 0)`.mapWith(
          Number,
        ),
      })
      .from(inventoryLot)
      .where(eq(inventoryLot.agentId, agentId));
    return rows[0]?.total ?? 0;
  },
};
