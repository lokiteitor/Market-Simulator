/**
 * Repositorio de resource_deposit (yacimientos finitos del patrón oro).
 *
 * Patrón lock-then-update: la materialización de producción bloquea la fila
 * del depósito (FOR UPDATE) DESPUÉS de haber bloqueado el proceso, calcula el
 * clamp en aplicación (lib/gold.clampMint) y decrementa. Orden de locks
 * consistente entre la materialización lazy y el sweeper ⇒ sin ciclos.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { Tx } from "../db";
import { resourceDeposit, type ResourceDepositRow } from "../db/schema";

export const depositRepository = {
  /** Alta del yacimiento (solo seed): arranca con remanente = inicial. */
  async insertDeposit(
    tx: Tx,
    p: { productId: string; qtyInitialCent: number },
  ): Promise<void> {
    await tx.insert(resourceDeposit).values({
      productId: p.productId,
      qtyInitialCent: p.qtyInitialCent,
      qtyRemainingCent: p.qtyInitialCent,
    });
  },

  /** Fila del depósito bloqueada FOR UPDATE, o undefined si el producto no tiene depósito. */
  async lockDeposit(tx: Tx, productId: string): Promise<ResourceDepositRow | undefined> {
    const rows = await tx
      .select()
      .from(resourceDeposit)
      .where(eq(resourceDeposit.productId, productId))
      .for("update");
    return rows[0];
  },

  /**
   * Decremento condicional (defensa además del lock): false si no había
   * remanente suficiente — con el lock previo y el clamp del caller esto es
   * inalcanzable salvo bug.
   */
  async decrement(tx: Tx, productId: string, qtyCent: number): Promise<boolean> {
    if (qtyCent <= 0) return true;
    const rows = await tx
      .update(resourceDeposit)
      .set({
        qtyRemainingCent: sql`${resourceDeposit.qtyRemainingCent} - ${qtyCent}`,
      })
      .where(
        and(
          eq(resourceDeposit.productId, productId),
          gte(resourceDeposit.qtyRemainingCent, qtyCent),
        ),
      )
      .returning({ productId: resourceDeposit.productId });
    return rows.length > 0;
  },

  /** Remanente sin lock (fail-fast de startTransformation), o undefined si no hay depósito. */
  async getRemaining(tx: Tx, productId: string): Promise<number | undefined> {
    const rows = await tx
      .select({ qtyRemainingCent: resourceDeposit.qtyRemainingCent })
      .from(resourceDeposit)
      .where(eq(resourceDeposit.productId, productId));
    return rows[0]?.qtyRemainingCent;
  },
};
