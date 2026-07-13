/**
 * Badge — etiqueta semántica de rol, estado o categoría.
 * Los colores provienen EXCLUSIVAMENTE de los tokens (tokens.css):
 * texto = color pleno del rol/estado; fondo = variante *-soft (contraste AA).
 *
 * Kinds admitidos:
 * - Roles: primary_producer, transformer, consumer, trader
 * - Estados: active, partial, completed, cancelled, expired, bankrupt
 *   (running es alias visual de active)
 * - Categorías de producto: raw_primary, intermediate, final_consumption
 * - Lados de orden: buy (verde), sell (rojo)
 * - neutral: fallback gris (también para kinds desconocidos en runtime)
 */
import type { ReactNode } from "react";

import styles from "./Badge.module.css";

export type BadgeKind =
  // roles
  | "primary_producer"
  | "transformer"
  | "consumer"
  | "trader"
  | "admin"
  | "bank"
  // estados
  | "active"
  | "partial"
  | "completed"
  | "cancelled"
  | "expired"
  | "bankrupt"
  | "running"
  // categorías de producto
  | "raw_primary"
  | "intermediate"
  | "final_consumption"
  // lado de orden
  | "buy"
  | "sell"
  // fallback
  | "neutral";

export interface BadgeProps {
  kind: BadgeKind;
  children: ReactNode;
}

const KIND_CLASS: Record<BadgeKind, string> = {
  primary_producer: styles["rolePrimaryProducer"] ?? "",
  transformer: styles["roleTransformer"] ?? "",
  consumer: styles["roleConsumer"] ?? "",
  trader: styles["roleTrader"] ?? "",
  admin: styles["neutral"] ?? styles["stateCancelled"] ?? "",
  bank: styles["roleTrader"] ?? "",
  active: styles["stateActive"] ?? "",
  partial: styles["statePartial"] ?? "",
  completed: styles["stateCompleted"] ?? "",
  cancelled: styles["stateCancelled"] ?? "",
  expired: styles["stateExpired"] ?? "",
  bankrupt: styles["stateBankrupt"] ?? "",
  running: styles["stateActive"] ?? "",
  raw_primary: styles["rolePrimaryProducer"] ?? "",
  intermediate: styles["roleTransformer"] ?? "",
  final_consumption: styles["roleConsumer"] ?? "",
  buy: styles["stateActive"] ?? "",
  sell: styles["stateBankrupt"] ?? "",
  neutral: styles["stateCancelled"] ?? "",
};

export function Badge({ kind, children }: BadgeProps) {
  const kindClass = KIND_CLASS[kind] ?? KIND_CLASS.neutral;
  return <span className={`${styles["badge"]} ${kindClass}`}>{children}</span>;
}
