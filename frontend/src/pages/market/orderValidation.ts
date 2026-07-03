/**
 * orderValidation.ts — lógica PURA de validación del formulario rápido de
 * órdenes (design doc §4.2), ejecutada ANTES de enviar `POST /orders`:
 *
 * - Cantidad y precio: decimales válidos (máx. 2 decimales), > 0.
 * - TTL simulado dentro de [60, 604800] (1 min … 1 semana simulados).
 * - Compra: capital disponible (self-state) ≥ qty × precio límite.
 * - Venta: inventario disponible del producto (self-state) ≥ qty.
 *
 * También mapea los `errors[]` de un Problem 422 (RFC 7807) a los campos
 * del formulario para mostrarlos inline junto al campo correspondiente.
 *
 * Sin dependencias de React: testeable con `bun test`.
 */
import type { OrderSide, Problem, ProblemFieldError } from "../../api/types";
import {
  fmtMoney,
  fmtQty,
  parseMoneyToCents,
  parseQtyToCent,
} from "../../lib/format";

/** TTL mínimo permitido por la API: 1 minuto simulado. */
export const TTL_MIN_SIM_SECONDS = 60;
/** TTL máximo permitido por la API: 1 semana simulada. */
export const TTL_MAX_SIM_SECONDS = 604_800;

/**
 * Campos del formulario a los que se anclan errores inline.
 * `form` agrupa los errores que dependen de varios campos a la vez
 * (p. ej. capital insuficiente = cantidad × precio vs. capital).
 */
export type OrderFormField = "qty" | "price" | "ttl" | "form";

export type OrderFieldErrors = Partial<Record<OrderFormField, string>>;

/** Estado crudo del formulario (inputs de texto sin parsear). */
export interface OrderDraft {
  side: OrderSide;
  /** Texto del input de cantidad, en unidades del producto. */
  qtyInput: string;
  /** Texto del input de precio límite por unidad. */
  priceInput: string;
  /** TTL seleccionado, en segundos SIMULADOS. */
  ttlSimSeconds: number;
}

/** Contexto del self-state para las validaciones de fondos/inventario. */
export interface OrderValidationContext {
  /** Capital disponible del agente, en centavos. */
  capitalAvailableCents: number;
  /** Inventario disponible del producto a operar, en centésimas. */
  inventoryAvailableCent: number;
  /** Unidad del producto (solo para mensajes). */
  unit?: string;
}

/** Valores ya parseados, listos para el `PlaceOrderRequest`. */
export interface OrderRequestValues {
  qty_cent: number;
  limit_price_cents: number;
  ttl_seconds: number;
}

export interface OrderValidationResult {
  errors: OrderFieldErrors;
  /** `null` si hay algún error. */
  values: OrderRequestValues | null;
}

/**
 * Capital necesario para una compra, en centavos:
 * qty (centésimas) × precio (centavos/unidad) / 100, redondeado hacia
 * ARRIBA (conservador: nunca subestima la reserva que hará el servidor).
 */
export function requiredCapitalCents(
  qtyCent: number,
  priceCents: number,
): number {
  return Math.ceil((qtyCent * priceCents) / 100);
}

/**
 * Valida el borrador del formulario. Si `ctx` es `null` (self-state aún
 * cargando) se omiten las comprobaciones de capital/inventario: el servidor
 * es la autoridad final y las re-valida siempre.
 */
export function validateOrderDraft(
  draft: OrderDraft,
  ctx: OrderValidationContext | null,
): OrderValidationResult {
  const errors: OrderFieldErrors = {};

  const qtyCent = parseQtyToCent(draft.qtyInput);
  if (qtyCent === null) {
    errors.qty =
      "Cantidad inválida: usa un número positivo con máximo 2 decimales.";
  } else if (qtyCent < 1) {
    errors.qty = "La cantidad debe ser mayor que cero.";
  }

  const priceCents = parseMoneyToCents(draft.priceInput);
  if (priceCents === null) {
    errors.price =
      "Precio inválido: usa un número positivo con máximo 2 decimales.";
  } else if (priceCents < 1) {
    errors.price = "El precio límite debe ser al menos $0.01.";
  }

  const ttl = draft.ttlSimSeconds;
  if (
    !Number.isInteger(ttl) ||
    ttl < TTL_MIN_SIM_SECONDS ||
    ttl > TTL_MAX_SIM_SECONDS
  ) {
    errors.ttl =
      "El TTL debe estar entre 1 minuto (60 s) y 1 semana (604 800 s) simulados.";
  }

  if (qtyCent !== null && qtyCent >= 1 && priceCents !== null && priceCents >= 1) {
    const required = requiredCapitalCents(qtyCent, priceCents);
    if (!Number.isSafeInteger(required)) {
      errors.form = "Cantidad × precio demasiado grande para procesarse.";
    } else if (draft.side === "buy" && ctx !== null) {
      if (required > ctx.capitalAvailableCents) {
        errors.form = `Capital insuficiente: la compra requiere ${fmtMoney(
          required,
        )} y tienes ${fmtMoney(ctx.capitalAvailableCents)} disponibles.`;
      }
    } else if (draft.side === "sell" && ctx !== null) {
      if (qtyCent > ctx.inventoryAvailableCent) {
        errors.qty = `Inventario insuficiente: quieres vender ${fmtQty(
          qtyCent,
          ctx.unit,
        )} y tienes ${fmtQty(ctx.inventoryAvailableCent, ctx.unit)} disponibles.`;
      }
    }
  }

  const hasErrors = Object.keys(errors).length > 0;
  const values =
    !hasErrors && qtyCent !== null && priceCents !== null
      ? { qty_cent: qtyCent, limit_price_cents: priceCents, ttl_seconds: ttl }
      : null;

  return { errors, values };
}

// ---------------------------------------------------------------------------
// 422 Problem+JSON → errores inline por campo
// ---------------------------------------------------------------------------

/** `errors[*].field` del request de la API → campo del formulario. */
const SERVER_FIELD_TO_FORM: Record<string, Exclude<OrderFormField, "form">> = {
  qty_cent: "qty",
  qty: "qty",
  limit_price_cents: "price",
  limit_price: "price",
  price: "price",
  ttl_seconds: "ttl",
  ttl: "ttl",
};

/** Códigos de dominio sin campo que igualmente se anclan al formulario. */
const FORM_LEVEL_CODES: ReadonlySet<string> = new Set([
  "insufficient_capital",
  "insufficient_inventory",
]);

export interface MappedOrderProblem {
  /** Errores anclados a campos del formulario. */
  fields: OrderFieldErrors;
  /** Errores sin campo mapeable (para mostrarse en un ErrorBanner). */
  unassigned: ProblemFieldError[];
}

/**
 * Mapea un `Problem` 422 a errores por campo del formulario. Los errores
 * que no correspondan a ningún campo quedan en `unassigned`.
 */
export function mapProblemToOrderErrors(problem: Problem): MappedOrderProblem {
  const fields: OrderFieldErrors = {};
  const unassigned: ProblemFieldError[] = [];

  for (const err of problem.errors ?? []) {
    const byField =
      err.field !== undefined && err.field !== null
        ? SERVER_FIELD_TO_FORM[err.field]
        : undefined;
    const key: OrderFormField | undefined =
      byField ?? (FORM_LEVEL_CODES.has(err.code) ? "form" : undefined);
    if (key === undefined) {
      unassigned.push(err);
      continue;
    }
    const prev = fields[key];
    fields[key] = prev === undefined ? err.message : `${prev} ${err.message}`;
  }

  return { fields, unassigned };
}
