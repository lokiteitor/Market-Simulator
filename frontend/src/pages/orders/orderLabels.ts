/**
 * orderLabels.ts — etiquetas en español para estados y lados de órdenes.
 * Archivo hoja compartido por OrdersPage y OrderFormModal (evita ciclos
 * de import entre la página y el modal).
 */
import type { OrderSide, OrderStatus } from "../../api/types";

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  active: "Activa",
  partial: "Parcial",
  completed: "Completada",
  cancelled: "Cancelada",
  expired: "Expirada",
};

export const ORDER_SIDE_LABEL: Record<OrderSide, string> = {
  buy: "Compra",
  sell: "Venta",
};
