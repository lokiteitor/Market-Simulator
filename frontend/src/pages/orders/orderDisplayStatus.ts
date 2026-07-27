/**
 * orderDisplayStatus.ts — estado de PRESENTACIÓN de una orden.
 *
 * El backend expira las órdenes con un barrido periódico
 * (`order-expiry-sweeper`, cada ~5 s), así que entre `expires_at` y el
 * `status='expired'` hay una ventana en la que la orden sigue figurando como
 * `active`/`partial` aunque el matching ya la ignora (`findBestCounterForUpdate`
 * filtra `expires_at > now()`). Ese hueco se pintaba como "Activa" y confundía.
 *
 * Aquí se deriva un estado extra, `expiring`, comparando `expires_at` con el
 * reloj del cliente. Es solo visual: no cambia nada del servidor.
 *
 * Cancelar en ese hueco SÍ es útil (y es lo que ofrece la UI como "Liberar
 * reservas"): expirar y cancelar comparten `releaseOrderReserves` en el
 * backend, así que libera exactamente lo mismo, solo que al instante.
 */
import type { Order, OrderStatus } from "../../api/types";
import { ORDER_STATUS_LABEL } from "./orderLabels";

/** Estados del contrato más el derivado en cliente. */
export type OrderDisplayStatus = OrderStatus | "expiring";

export const ORDER_DISPLAY_STATUS_LABEL: Record<OrderDisplayStatus, string> = {
  ...ORDER_STATUS_LABEL,
  expiring: "Vencida",
};

/** Explicación del estado derivado (tooltip compartido por las tablas). */
export const EXPIRING_HINT =
  "Ya venció: no puede casar. El barrido libera sus reservas en unos segundos.";

/** Estados del contrato considerados abiertos por el backend. */
const OPEN_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "active",
  "partial",
]);

/**
 * `active`/`partial` con `expires_at` ya pasado → `expiring`.
 * Una fecha inválida nunca marca vencimiento (mejor mostrar el estado del
 * servidor que inventarse uno).
 */
export function orderDisplayStatus(
  order: Pick<Order, "status" | "expires_at">,
  nowMs: number,
): OrderDisplayStatus {
  if (!OPEN_STATUSES.has(order.status)) return order.status;
  const expiresMs = Date.parse(order.expires_at);
  if (Number.isNaN(expiresMs)) return order.status;
  return expiresMs <= nowMs ? "expiring" : order.status;
}

/** ¿Se puede llamar a DELETE /orders/{id} con efecto? */
export function isCancellable(status: OrderDisplayStatus): boolean {
  return status === "active" || status === "partial" || status === "expiring";
}

/** Reservas que el backend devolverá al cancelar o expirar la orden. */
export type ReserveRelease =
  | { kind: "capital"; cents: number }
  | { kind: "goods"; qtyCent: number };

/**
 * Espejo de `releaseOrderReserves` del backend: un bid devuelve el nocional
 * pendiente al precio límite (floor(qty × precio / 100)); un ask devuelve la
 * mercancía pendiente a los lotes FIFO de origen.
 */
export function reserveRelease(
  order: Pick<Order, "side" | "qty_pending_cent" | "limit_price_cents">,
): ReserveRelease {
  if (order.side === "buy") {
    return {
      kind: "capital",
      cents: Math.floor(
        (order.qty_pending_cent * order.limit_price_cents) / 100,
      ),
    };
  }
  return { kind: "goods", qtyCent: order.qty_pending_cent };
}
