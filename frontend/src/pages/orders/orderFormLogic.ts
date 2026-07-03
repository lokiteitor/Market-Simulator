/**
 * orderFormLogic.ts — lógica PURA del formulario de creación de órdenes [FE7]
 * (sin React; validaciones del design doc §4.2 y de specs/openapi.yaml).
 *
 * Decisión documentada: el formulario de órdenes se implementa LOCALMENTE en
 * pages/orders (OrderFormModal) en lugar de importar el formulario rápido de
 * pages/market — importar componentes entre páginas acoplaría módulos de
 * agentes distintos ([FE6]/[FE7]). Sí se importan HOJAS puras compartidas
 * (../market/simTime para el factor de simulación y los presets de TTL):
 * duplicar el factor 5× en dos sitios sería peor que la dependencia.
 */
import type { OrderSide, PlaceOrderRequest } from "../../api/types";
import {
  fmtMoney,
  fmtQty,
  parseMoneyToCents,
  parseQtyToCent,
} from "../../lib/format";

// ---------------------------------------------------------------------------
// Reglas del openapi (PlaceOrderRequest)
// ---------------------------------------------------------------------------

/** TTL mínimo: 1 minuto SIMULADO (openapi: ttl_seconds ≥ 60). */
export const TTL_MIN_SIM_SECONDS = 60;
/** TTL máximo: 1 semana SIMULADA (openapi: ttl_seconds ≤ 604800). */
export const TTL_MAX_SIM_SECONDS = 604_800;

/** Campos del request mapeables a errores inline (422 → errors[].field). */
export const ORDER_FIELDS = [
  "product_id",
  "side",
  "qty_cent",
  "limit_price_cents",
  "ttl_seconds",
] as const;

export type OrderField = (typeof ORDER_FIELDS)[number];

export type OrderFieldErrors = Partial<Record<OrderField, string>>;

// ---------------------------------------------------------------------------
// Nocional (misma fórmula entera que el backend: floor(qty × price / 100))
// ---------------------------------------------------------------------------

/**
 * Valor nocional en centavos: floor(qtyCent × priceCents / 100).
 * `priceCents` es por unidad ENTERA; `qtyCent` está en centésimas.
 * Producto exacto con BigInt (sin redondeos flotantes intermedios).
 */
export function notionalCents(qtyCent: number, priceCents: number): number {
  return Number((BigInt(qtyCent) * BigInt(priceCents)) / 100n);
}

// ---------------------------------------------------------------------------
// Validación del formulario
// ---------------------------------------------------------------------------

export interface OrderFormValues {
  productId: string;
  side: OrderSide;
  /** Texto crudo del input de cantidad (se parsea a centésimas). */
  qtyText: string;
  /** Texto crudo del input de precio límite (se parsea a centavos). */
  priceText: string;
  /** TTL elegido, en segundos SIMULADOS. */
  ttlSimSeconds: number;
  /** UUID de idempotencia generado por la UI (crypto.randomUUID()). */
  clientOrderId: string;
}

export interface OrderFormContext {
  /** Capital disponible del agente (centavos) — valida compras. */
  capitalAvailableCents: number;
  /** Inventario disponible del producto elegido (centésimas) — valida ventas. */
  inventoryAvailableCent: number;
  /** Unidad del producto elegido (para mensajes legibles). */
  unit?: string;
}

export interface OrderFormResult {
  /** Errores por campo (inline junto al input). */
  errors: OrderFieldErrors;
  /**
   * Error de dominio no ligado a un campo concreto
   * (capital/inventario insuficiente). `null` si no aplica.
   */
  domainError: string | null;
  /** Request listo para POST /orders, o `null` si hay errores. */
  request: PlaceOrderRequest | null;
}

/**
 * Valida el formulario completo (design doc §4.2):
 * - cantidad y precio: decimales positivos con máx. 2 decimales;
 * - TTL simulado dentro de [60, 604800];
 * - compra: capital disponible ≥ floor(qty × precio / 100);
 * - venta: inventario disponible ≥ cantidad.
 */
export function validateOrderForm(
  values: OrderFormValues,
  ctx: OrderFormContext,
): OrderFormResult {
  const errors: OrderFieldErrors = {};
  let domainError: string | null = null;

  if (values.productId === "") {
    errors.product_id = "Selecciona un producto.";
  }

  const qtyCent = parseQtyToCent(values.qtyText);
  if (qtyCent === null) {
    errors.qty_cent =
      "Cantidad inválida: usa un número positivo con máximo 2 decimales.";
  } else if (qtyCent < 1) {
    errors.qty_cent = "La cantidad debe ser mayor que cero.";
  }

  const priceCents = parseMoneyToCents(values.priceText);
  if (priceCents === null) {
    errors.limit_price_cents =
      "Precio inválido: usa un número positivo con máximo 2 decimales.";
  } else if (priceCents < 1) {
    errors.limit_price_cents = "El precio límite debe ser mayor que cero.";
  }

  if (
    !Number.isInteger(values.ttlSimSeconds) ||
    values.ttlSimSeconds < TTL_MIN_SIM_SECONDS ||
    values.ttlSimSeconds > TTL_MAX_SIM_SECONDS
  ) {
    errors.ttl_seconds =
      "El TTL debe estar entre 1 minuto y 1 semana simulados.";
  }

  // Validaciones de dominio (solo si cantidad y precio son parseables).
  if (
    qtyCent !== null &&
    priceCents !== null &&
    qtyCent >= 1 &&
    priceCents >= 1
  ) {
    if (values.side === "buy") {
      const requiredCents = notionalCents(qtyCent, priceCents);
      if (requiredCents > ctx.capitalAvailableCents) {
        domainError =
          `Capital insuficiente: la compra requiere reservar ` +
          `${fmtMoney(requiredCents)} y tienes ` +
          `${fmtMoney(ctx.capitalAvailableCents)} disponibles.`;
      }
    } else if (qtyCent > ctx.inventoryAvailableCent) {
      domainError =
        `Inventario insuficiente: quieres vender ` +
        `${fmtQty(qtyCent, ctx.unit)} y tienes ` +
        `${fmtQty(ctx.inventoryAvailableCent, ctx.unit)} disponibles.`;
    }
  }

  if (
    Object.keys(errors).length > 0 ||
    domainError !== null ||
    qtyCent === null ||
    priceCents === null
  ) {
    return { errors, domainError, request: null };
  }

  return {
    errors,
    domainError,
    request: {
      product_id: values.productId,
      side: values.side,
      qty_cent: qtyCent,
      limit_price_cents: priceCents,
      ttl_seconds: values.ttlSimSeconds,
      client_order_id: values.clientOrderId,
    },
  };
}
