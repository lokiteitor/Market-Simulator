/**
 * bankMath.ts — lógica PURA de la ventanilla del banco central (sin React):
 * total de una conversión, precio aplicable por dirección y validación
 * client-side que replica los 422 del contrato (POST /bank/convert).
 */
import type { BankInfo, ConversionDirection } from "../../api/types";

/** Etiqueta humana por dirección (perspectiva del agente). */
export const DIRECTION_LABEL: Record<ConversionDirection, string> = {
  sell_gold: "Vender oro al banco (acuña dinero)",
  buy_gold: "Comprar oro al banco (destruye dinero)",
};

/**
 * Total de la conversión: floor(qty_cent × price_cents_per_unit / 100).
 * BigInt para no perder precisión con cantidades grandes (misma técnica que
 * `estimateWageCents` en transformMath). Sin fees (contrato del banco).
 */
export function conversionTotalCents(
  qtyCent: number,
  priceCentsPerUnit: number,
): number {
  return Number((BigInt(qtyCent) * BigInt(priceCentsPerUnit)) / 100n);
}

/** Precio de ventanilla aplicable: bid si el agente vende oro, ask si compra. */
export function conversionPriceCents(
  bank: BankInfo,
  direction: ConversionDirection,
): number {
  return direction === "sell_gold"
    ? bank.window_bid_cents
    : bank.window_ask_cents;
}

export interface ConversionCheck {
  direction: ConversionDirection;
  /** Centésimas de unidad de oro a convertir. */
  qtyCent: number;
  priceCentsPerUnit: number;
  /** Oro disponible del agente (inventario). */
  goldAvailableCent: number;
  /** Capital disponible del agente. */
  capitalAvailableCents: number;
  /** Reserva de oro del banco. */
  bankGoldAvailableCent: number;
}

/**
 * Validación previa al POST; devuelve el mensaje de error o `null` si la
 * conversión es viable. Réplica de las causas 422 del contrato:
 * `conversion_below_minimum`, `insufficient_inventory` (sell),
 * `bank_insufficient_gold` y `insufficient_capital` (buy). El servidor sigue
 * siendo autoritativo (el estado puede cambiar entre el preview y el POST).
 */
export function validateConversion(c: ConversionCheck): string | null {
  if (!Number.isInteger(c.qtyCent) || c.qtyCent < 1) {
    return "Introduce una cantidad de oro válida (mayor que cero).";
  }
  if (conversionTotalCents(c.qtyCent, c.priceCentsPerUnit) < 1) {
    return "La cantidad es tan pequeña que el importe redondea a $0.00.";
  }
  if (c.direction === "sell_gold" && c.qtyCent > c.goldAvailableCent) {
    return "No tienes tanto oro disponible en tu inventario.";
  }
  if (c.direction === "buy_gold") {
    if (c.qtyCent > c.bankGoldAvailableCent) {
      return "El banco no tiene tanto oro en reserva.";
    }
    const total = conversionTotalCents(c.qtyCent, c.priceCentsPerUnit);
    if (total > c.capitalAvailableCents) {
      return "Capital disponible insuficiente para pagar la conversión.";
    }
  }
  return null;
}
