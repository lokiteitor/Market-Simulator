// Event log append-only (CONTRATOS_IMPLEMENTACION.md §9) — [F5 contracts]
//
// appendEvent se llama SIEMPRE dentro de la transacción de la mutación de
// dominio que registra (regla §0). Las notificaciones Redis asociadas se
// publican SOLO post-commit (ver src/notifier).

import type { Tx } from "../db";
import { eventLog, eventType } from "../db/schema";
import type { AgentRole } from "../types/contracts";

/** Tipos de evento, derivados del enum event_type del schema. */
export type EventType = (typeof eventType.enumValues)[number];

/**
 * Inserta un evento en event_log dentro de la transacción dada y devuelve el
 * event_id generado. `agentId` es opcional (eventos del sistema → NULL).
 */
export async function appendEvent(
  tx: Tx,
  e: { type: EventType; agentId?: string; payload: unknown },
): Promise<string> {
  const rows = await tx
    .insert(eventLog)
    .values({
      eventType: e.type,
      agentId: e.agentId ?? null,
      payload: e.payload,
    })
    .returning({ eventId: eventLog.eventId });
  const row = rows[0];
  if (row === undefined) {
    // INSERT ... RETURNING siempre devuelve la fila insertada; esto solo puede
    // ocurrir ante un fallo del driver.
    throw new Error("event_log insert returned no rows");
  }
  return row.eventId;
}

// ---------------------------------------------------------------------------
// Payloads por tipo de evento (snake_case, mínimos — contrato §9).
// Los módulos construyen estos objetos y los pasan como `payload`.
// ---------------------------------------------------------------------------

export interface AgentRegisteredPayload {
  agent_id: string;
  username: string;
  role: AgentRole;
  seed_capital_cents: number;
}

export interface AgentBankruptPayload {
  agent_id: string;
  username: string;
}

export interface OrderPlacedPayload {
  order_id: string;
  agent_id: string;
  product_id: string;
  side: "buy" | "sell";
  qty_cent: number;
  limit_price_cents: number;
  /** ISO 8601. */
  expires_at: string;
}

export interface OrderCancelledPayload {
  order_id: string;
  agent_id: string;
  product_id: string;
  qty_pending_cent: number;
}

export type OrderExpiredPayload = OrderCancelledPayload;

export interface TradeExecutedPayload {
  trade_id: string;
  buy_order_id: string;
  sell_order_id: string;
  buyer_agent_id: string;
  seller_agent_id: string;
  product_id: string;
  qty_cent: number;
  price_cents: number;
  fee_buyer_cents: number;
  fee_seller_cents: number;
}

export interface ProcessStartedPayload {
  process_id: string;
  agent_id: string;
  recipe_id: string;
  executions: number;
  wage_paid_cents: number;
  /** ISO 8601. */
  expected_end_at: string;
}

export interface ProcessCompletedPayload {
  process_id: string;
  agent_id: string;
  recipe_id: string;
  output_product_id: string;
  qty_produced_cent: number;
  output_lot_id: string;
}

export interface ProcessCancelledPayload {
  process_id: string;
  agent_id: string;
}

export interface SnapshotTakenPayload {
  snapshot_id: string;
  note: string;
}

/** Mapa tipo de evento → payload, para uso genérico por los módulos. */
export interface EventPayloads {
  agent_registered: AgentRegisteredPayload;
  agent_bankrupt: AgentBankruptPayload;
  order_placed: OrderPlacedPayload;
  order_cancelled: OrderCancelledPayload;
  order_expired: OrderExpiredPayload;
  trade_executed: TradeExecutedPayload;
  process_started: ProcessStartedPayload;
  process_completed: ProcessCompletedPayload;
  process_cancelled: ProcessCancelledPayload;
  snapshot_taken: SnapshotTakenPayload;
}
