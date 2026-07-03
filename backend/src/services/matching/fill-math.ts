/**
 * Aritmética PURA de un fill del matching engine (§5, §10.1) — [M3 orders].
 *
 * Sin DB ni side-effects: dado el estado de la orden agresora (taker) y de la
 * pasiva (la que estaba en el libro), calcula cantidades, precio efectivo,
 * costo, movimientos de reserva del comprador (regla telescópica de §5) y el
 * fee ideal por lado. El engine aplica estos números con las transferencias
 * atómicas de `capital.ts`.
 *
 * Reglas fijadas por el contrato:
 *   - Precio efectivo = limit de la orden PASIVA.
 *   - qty ejecutada = min(pendientes).
 *   - Liberación de reserva del comprador (telescópica):
 *       r = notional(pend_antes, limit_compra) − notional(pend_después, limit_compra)
 *     y r ≥ cost SIEMPRE (monotonía del floor), por lo que el sobrante
 *     (r − cost) vuelve a capital_available.
 *   - Fee por lado: min(feeCents(cost), capital_available) — el cap se aplica
 *     en `capital.ts` porque depende del estado del agente.
 */
import { feeCents, notionalCents, releaseForFill, unitCostFromTotal } from "../../lib/money";

export type FillSide = "buy" | "sell";

/** Resultado de un fill para una orden: quedó completa o sigue parcial. */
export type Fill = "partial" | "full";

export interface FillInput {
  /** Lado de la orden agresora (la recién insertada). */
  takerSide: FillSide;
  takerQtyPendingCent: number;
  takerLimitPriceCents: number;
  /** Pendiente de la orden pasiva (contraparte del libro). */
  passiveQtyPendingCent: number;
  passiveLimitPriceCents: number;
}

export interface FillPlan {
  /** Cantidad ejecutada = min(pendientes). */
  execQtyCent: number;
  /** Precio efectivo = el de la orden pasiva. */
  priceCents: number;
  /** cost = notional(execQty, price): lo que paga el comprador al vendedor. */
  costCents: number;
  /** Liberación telescópica de la reserva del comprador (≥ costCents). */
  buyerReserveReleaseCents: number;
  /** Sobrante de la liberación que vuelve a available: release − cost. */
  buyerRefundCents: number;
  /** feeCents(cost): fee ideal por lado, ANTES del cap por available. */
  idealFeeCents: number;
  takerQtyPendingAfterCent: number;
  passiveQtyPendingAfterCent: number;
  takerFill: Fill;
  passiveFill: Fill;
}

/**
 * ¿Cruzan los precios? (condición de compatibilidad §10.1)
 *   taker buy : la pasiva es sell y su limit ≤ mi limit.
 *   taker sell: la pasiva es buy y su limit ≥ mi limit.
 */
export function pricesCross(
  takerSide: FillSide,
  takerLimitPriceCents: number,
  passiveLimitPriceCents: number,
): boolean {
  return takerSide === "buy"
    ? passiveLimitPriceCents <= takerLimitPriceCents
    : passiveLimitPriceCents >= takerLimitPriceCents;
}

/**
 * Calcula el plan numérico de un fill. Lanza Error (invariante interno, no
 * DomainError) si las órdenes no son casables: el engine solo debe llamar con
 * contrapartes ya filtradas por la query de mejor contraparte.
 */
export function planFill(input: FillInput): FillPlan {
  const {
    takerSide,
    takerQtyPendingCent,
    takerLimitPriceCents,
    passiveQtyPendingCent,
    passiveLimitPriceCents,
  } = input;

  if (takerQtyPendingCent <= 0 || passiveQtyPendingCent <= 0) {
    throw new Error(
      `planFill: pendientes deben ser > 0 (taker=${takerQtyPendingCent}, passive=${passiveQtyPendingCent})`,
    );
  }
  if (!pricesCross(takerSide, takerLimitPriceCents, passiveLimitPriceCents)) {
    throw new Error(
      `planFill: precios no cruzan (takerSide=${takerSide}, taker=${takerLimitPriceCents}, passive=${passiveLimitPriceCents})`,
    );
  }

  const execQtyCent = Math.min(takerQtyPendingCent, passiveQtyPendingCent);
  const priceCents = passiveLimitPriceCents;
  const costCents = notionalCents(execQtyCent, priceCents);

  // El comprador es el taker si compra; si no, la pasiva. La reserva se libera
  // SIEMPRE contra el limit del COMPRADOR (así se reservó).
  const buyerQtyPendingBefore = takerSide === "buy" ? takerQtyPendingCent : passiveQtyPendingCent;
  const buyerLimitPriceCents = takerSide === "buy" ? takerLimitPriceCents : passiveLimitPriceCents;
  const buyerReserveReleaseCents = releaseForFill(
    buyerQtyPendingBefore,
    buyerQtyPendingBefore - execQtyCent,
    buyerLimitPriceCents,
  );
  const buyerRefundCents = buyerReserveReleaseCents - costCents;
  if (buyerRefundCents < 0) {
    // Imposible por monotonía del floor con price ≤ limit del comprador.
    throw new Error(
      `planFill: liberación ${buyerReserveReleaseCents} < costo ${costCents} — invariante §5 violado`,
    );
  }

  const takerQtyPendingAfterCent = takerQtyPendingCent - execQtyCent;
  const passiveQtyPendingAfterCent = passiveQtyPendingCent - execQtyCent;

  return {
    execQtyCent,
    priceCents,
    costCents,
    buyerReserveReleaseCents,
    buyerRefundCents,
    idealFeeCents: feeCents(costCents),
    takerQtyPendingAfterCent,
    passiveQtyPendingAfterCent,
    takerFill: takerQtyPendingAfterCent === 0 ? "full" : "partial",
    passiveFill: passiveQtyPendingAfterCent === 0 ? "full" : "partial",
  };
}

/** Fee efectivo por lado: min(fee ideal, available) — nunca viola capital ≥ 0. */
export function cappedFeeCents(idealFeeCents: number, capitalAvailableCents: number): number {
  return Math.min(idealFeeCents, capitalAvailableCents);
}

/**
 * unit_cost_cents del lote purchase del comprador (§5):
 *   unitCostFromTotal(cost + fee_buyer, execQty), con el fee REALMENTE cobrado.
 */
export function buyerLotUnitCostCents(
  costCents: number,
  feeBuyerCents: number,
  execQtyCent: number,
): number {
  return unitCostFromTotal(costCents + feeBuyerCents, execQtyCent);
}
