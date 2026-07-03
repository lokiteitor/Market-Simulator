/**
 * Aritmética de dinero y cantidades (contrato §5).
 *
 * Cantidades: BIGINT en centésimas de unidad (`qtyCent`; 1.5 kg = 150).
 * Dinero: centavos (`cents`). Ambos viajan como `number` en TS, pero TODA
 * multiplicación/división pasa por BigInt para evitar pérdida de precisión;
 * el redondeo es SIEMPRE floor (división entera de BigInt sobre positivos).
 */
import { config } from "../config";

function toBigInt(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} debe ser un entero seguro; recibido: ${value}`);
  }
  return BigInt(value);
}

/**
 * Valor nocional en centavos: floor(qtyCent × priceCents / 100).
 * (priceCents es por UNIDAD entera; qtyCent está en centésimas de unidad.)
 */
export function notionalCents(qtyCent: number, priceCents: number): number {
  return Number((toBigInt(qtyCent, "qtyCent") * toBigInt(priceCents, "priceCents")) / 100n);
}

/**
 * Fee por lado de un trade: fijo + floor(notional × rateBps / 10000).
 * Parámetros de `config.fees` (§3).
 */
export function feeCents(notional: number): number {
  return (
    config.fees.fixedCents +
    Number((toBigInt(notional, "notional") * BigInt(config.fees.rateBps)) / 10000n)
  );
}

/**
 * Costo por UNIDAD entera: floor(totalCents × 100 / qtyCent).
 * Usado para `unit_cost_cents` de lotes (compra: cost + fee_buyer; producción:
 * insumos + salario).
 */
export function unitCostFromTotal(totalCents: number, qtyCent: number): number {
  const qty = toBigInt(qtyCent, "qtyCent");
  if (qty <= 0n) {
    throw new Error(`unitCostFromTotal: qtyCent debe ser > 0; recibido: ${qtyCent}`);
  }
  return Number((toBigInt(totalCents, "totalCents") * 100n) / qty);
}

/**
 * Reserva inicial de una orden de compra = notionalCents(qty_original, limit).
 *
 * REGLA TELESCÓPICA (§5, no negociable): en cada fill se libera
 *   r = notionalCents(qty_pend_antes, limit) − notionalCents(qty_pend_despues, limit)
 * y al cierre (fill total / cancel / expire) se libera notionalCents(qty_pending, limit).
 * La suma telescópica de liberaciones reproduce EXACTAMENTE la reserva inicial,
 * de modo que capital_reserved cierra en 0 sin residuos de redondeo.
 * Fees NUNCA se reservan: salen de capital_available en el momento del trade.
 */
export function reserveForQty(qtyCent: number, limitPriceCents: number): number {
  return notionalCents(qtyCent, limitPriceCents);
}

/**
 * Liberación de reserva por un fill (término del telescopio):
 *   notional(qty_pend_antes, limit) − notional(qty_pend_despues, limit).
 * Propiedad (monotonía del floor): la liberación siempre cubre el costo
 * notionalCents(execQty, p) para todo p ≤ limit; el sobrante vuelve a available.
 */
export function releaseForFill(
  qtyPendingBeforeCent: number,
  qtyPendingAfterCent: number,
  limitPriceCents: number,
): number {
  return (
    notionalCents(qtyPendingBeforeCent, limitPriceCents) -
    notionalCents(qtyPendingAfterCent, limitPriceCents)
  );
}
