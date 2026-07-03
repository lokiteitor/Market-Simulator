/**
 * eventLabels.ts — lógica PURA del historial [FE7] (sin React):
 * etiquetas legibles de tipos de evento, mapeo a Badge y resumen
 * humano-legible del payload libre del event_log.
 */
import type { EventType } from "../../api/types";
import type { BadgeKind } from "../../components";
import { fmtDateTime, fmtMoney, fmtQty, truncId } from "../../lib/format";

// ---------------------------------------------------------------------------
// Tipos de evento → etiqueta y Badge
// ---------------------------------------------------------------------------

export const EVENT_TYPE_LABEL: Record<EventType, string> = {
  agent_registered: "Agente registrado",
  agent_bankrupt: "Quiebra de agente",
  order_placed: "Orden colocada",
  order_cancelled: "Orden cancelada",
  order_expired: "Orden expirada",
  trade_executed: "Trade ejecutado",
  process_started: "Proceso iniciado",
  process_completed: "Proceso completado",
  process_cancelled: "Proceso cancelado",
  snapshot_taken: "Snapshot del sistema",
};

export const EVENT_TYPE_BADGE: Record<EventType, BadgeKind> = {
  agent_registered: "active",
  agent_bankrupt: "bankrupt",
  order_placed: "active",
  order_cancelled: "cancelled",
  order_expired: "expired",
  trade_executed: "completed",
  process_started: "active",
  process_completed: "completed",
  process_cancelled: "cancelled",
  snapshot_taken: "neutral",
};

/** Etiqueta con fallback al tipo crudo (por si el API añade tipos nuevos). */
export function eventTypeLabel(type: string): string {
  return (
    (EVENT_TYPE_LABEL as Record<string, string | undefined>)[type] ?? type
  );
}

/** BadgeKind con fallback neutral para tipos desconocidos en runtime. */
export function eventTypeBadge(type: string): BadgeKind {
  return (
    (EVENT_TYPE_BADGE as Record<string, BadgeKind | undefined>)[type] ??
    "neutral"
  );
}

// ---------------------------------------------------------------------------
// Resumen del payload (libre por event_type) → texto corto legible
// ---------------------------------------------------------------------------

/** Etiquetas en español para las claves conocidas del payload. */
const KEY_LABEL: Record<string, string> = {
  order_id: "orden",
  trade_id: "trade",
  process_id: "proceso",
  recipe_id: "receta",
  product_id: "producto",
  agent_id: "agente",
  buyer_agent_id: "comprador",
  seller_agent_id: "vendedor",
  buy_order_id: "orden de compra",
  sell_order_id: "orden de venta",
  lot_id: "lote",
  snapshot_id: "snapshot",
  qty_cent: "cantidad",
  qty_executed_cent: "cantidad",
  qty_original_cent: "cantidad",
  qty_pending_cent: "pendiente",
  output_qty_cent: "producido",
  limit_price_cents: "límite",
  price_cents: "precio",
  wage_paid_cents: "salario",
  fee_buyer_cents: "fee comprador",
  fee_seller_cents: "fee vendedor",
  capital_cents: "capital",
  capital_available_cents: "capital disponible",
  side: "lado",
  status: "estado",
  role: "rol",
  username: "usuario",
  executions_planned: "ejecuciones",
  current_execution: "ejecución",
  ttl_seconds: "TTL (s sim)",
  reason: "motivo",
};

const SIDE_VALUE_LABEL: Record<string, string> = {
  buy: "compra",
  sell: "venta",
  buyer: "comprador",
  seller: "vendedor",
};

/** Máximo de pares clave:valor incluidos en el resumen. */
const MAX_SUMMARY_PAIRS = 4;

/**
 * Formatea UN valor del payload según la convención de su clave
 * (`*_cents` dinero, `*_cent` cantidades, `*_id` truncado, `*_at` fecha).
 * Devuelve `null` para valores no resumibles (objetos anidados, arrays).
 */
function formatPayloadValue(
  key: string,
  value: unknown,
  productName: (productId: string) => string,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "sí" : "no";

  if (typeof value === "number") {
    if (key.endsWith("_cents")) return fmtMoney(value);
    if (key.endsWith("_cent")) return fmtQty(value);
    return String(value);
  }

  if (typeof value === "string") {
    if (key === "product_id") return productName(value);
    if (key.endsWith("_id")) return truncId(value);
    if (key.endsWith("_at")) return fmtDateTime(value);
    if (key === "side") return SIDE_VALUE_LABEL[value] ?? value;
    return value.length > 48 ? `${value.slice(0, 48)}…` : value;
  }

  return null; // objetos/arrays anidados: solo en el JSON expandible
}

/**
 * Resumen corto del payload: hasta 4 pares "clave: valor" formateados
 * ("producto: Trigo · cantidad: 12.00 · precio: $3.50"). "—" si no hay
 * nada resumible; el JSON completo queda en el expandible de la fila.
 */
export function summarizeEventPayload(
  payload: Record<string, unknown>,
  productName: (productId: string) => string,
): string {
  const parts: string[] = [];
  let truncated = false;

  for (const [key, value] of Object.entries(payload)) {
    const formatted = formatPayloadValue(key, value, productName);
    if (formatted === null) continue;
    if (parts.length === MAX_SUMMARY_PAIRS) {
      truncated = true;
      break;
    }
    parts.push(`${KEY_LABEL[key] ?? key}: ${formatted}`);
  }

  if (parts.length === 0) return "—";
  return truncated ? `${parts.join(" · ")} · …` : parts.join(" · ");
}
