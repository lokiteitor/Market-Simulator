/**
 * Movimientos atómicos de capital sobre la tabla `agent` (§5, §10.3) — [M3 orders].
 *
 * Regla §10.3 (no negociable): los descuentos de capital se hacen SIEMPRE con
 *   UPDATE agent SET capital_x = capital_x - $n WHERE agent_id = $id AND capital_x >= $n
 * y verificación de filas afectadas (0 filas ⇒ error). Nunca check-then-act
 * separado — salvo bajo FOR UPDATE de la fila (caso del fee capado).
 *
 * Todas las funciones reciben `tx` y operan dentro de la transacción del
 * service llamador (placeOrder / matching / cancel / expire).
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { Tx } from "../../db";
import { agent } from "../../db/schema";
import { domainError } from "../../lib/errors";

/**
 * Reserva capital del comprador al colocar una orden de compra:
 * available → reserved. 0 filas ⇒ insufficient_capital (422).
 */
export async function reserveBuyerCapital(tx: Tx, agentId: string, cents: number): Promise<void> {
  const rows = await tx
    .update(agent)
    .set({
      capitalAvailable: sql`${agent.capitalAvailable} - ${cents}`,
      capitalReserved: sql`${agent.capitalReserved} + ${cents}`,
    })
    .where(and(eq(agent.agentId, agentId), gte(agent.capitalAvailable, cents)))
    .returning({ agentId: agent.agentId });
  if (rows.length === 0) {
    throw domainError(
      "insufficient_capital",
      `Se requieren ${cents} centavos disponibles para reservar la orden de compra.`,
      { field: "qty_cent" },
    );
  }
}

/**
 * Aplica al comprador el movimiento de capital de un fill (§5):
 *   reserved  -= releaseCents            (liberación telescópica)
 *   available += releaseCents - costCents (sobrante; el costo se paga al vendedor)
 * 0 filas ⇒ invariante roto (la reserva no cubre la liberación): Error 500.
 */
export async function applyBuyerFillCapital(
  tx: Tx,
  agentId: string,
  releaseCents: number,
  costCents: number,
): Promise<void> {
  const refundCents = releaseCents - costCents;
  if (refundCents < 0) {
    throw new Error(
      `applyBuyerFillCapital: liberación ${releaseCents} < costo ${costCents} (agente ${agentId})`,
    );
  }
  const rows = await tx
    .update(agent)
    .set({
      capitalReserved: sql`${agent.capitalReserved} - ${releaseCents}`,
      capitalAvailable: sql`${agent.capitalAvailable} + ${refundCents}`,
    })
    .where(and(eq(agent.agentId, agentId), gte(agent.capitalReserved, releaseCents)))
    .returning({ agentId: agent.agentId });
  if (rows.length === 0) {
    throw new Error(
      `applyBuyerFillCapital: capital_reserved del agente ${agentId} no cubre la liberación de ${releaseCents}`,
    );
  }
}

/**
 * Devuelve capital reservado a available (cierre de orden de compra:
 * cancelación/expiración — §5: notional(qty_pending, limit)).
 */
export async function releaseReservedCapital(tx: Tx, agentId: string, cents: number): Promise<void> {
  const rows = await tx
    .update(agent)
    .set({
      capitalReserved: sql`${agent.capitalReserved} - ${cents}`,
      capitalAvailable: sql`${agent.capitalAvailable} + ${cents}`,
    })
    .where(and(eq(agent.agentId, agentId), gte(agent.capitalReserved, cents)))
    .returning({ agentId: agent.agentId });
  if (rows.length === 0) {
    throw new Error(
      `releaseReservedCapital: capital_reserved del agente ${agentId} no cubre ${cents}`,
    );
  }
}

/** Acredita `cents` al available del agente (el vendedor cobra el costo del trade). */
export async function creditAvailable(tx: Tx, agentId: string, cents: number): Promise<void> {
  const rows = await tx
    .update(agent)
    .set({ capitalAvailable: sql`${agent.capitalAvailable} + ${cents}` })
    .where(eq(agent.agentId, agentId))
    .returning({ agentId: agent.agentId });
  if (rows.length === 0) {
    throw new Error(`creditAvailable: agente ${agentId} no existe`);
  }
}

/**
 * Cobra el fee de un lado del trade, capado al available del agente (§5):
 *   fee = min(idealFeeCents, capital_available)
 * Lee available con FOR UPDATE (el cap depende del valor actual) y luego
 * descuenta con UPDATE condicional. Devuelve el fee REALMENTE cobrado, que es
 * el que se persiste en la fila del trade.
 */
export async function chargeFeeCapped(
  tx: Tx,
  agentId: string,
  idealFeeCents: number,
): Promise<number> {
  const rows = await tx
    .select({ capitalAvailable: agent.capitalAvailable })
    .from(agent)
    .where(eq(agent.agentId, agentId))
    .limit(1)
    .for("update");
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`chargeFeeCapped: agente ${agentId} no existe`);
  }
  const fee = Math.min(idealFeeCents, row.capitalAvailable);
  if (fee > 0) {
    const updated = await tx
      .update(agent)
      .set({ capitalAvailable: sql`${agent.capitalAvailable} - ${fee}` })
      .where(and(eq(agent.agentId, agentId), gte(agent.capitalAvailable, fee)))
      .returning({ agentId: agent.agentId });
    if (updated.length === 0) {
      // Imposible: la fila está bloqueada por el FOR UPDATE de arriba.
      throw new Error(`chargeFeeCapped: capital_available del agente ${agentId} cambió bajo lock`);
    }
  }
  return fee;
}
