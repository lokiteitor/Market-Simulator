/**
 * types.ts — Tipos TypeScript fieles a `specs/openapi.yaml`
 * (components/schemas) para los datos que consume la UI.
 *
 * Convenciones del dominio (NUNCA mostrar estos enteros crudos en la UI;
 * usar los helpers de src/lib/format.ts):
 * - `*_cents`  → dinero en centavos (entero). Ej. `25000` = `$250.00`.
 * - `*_cent`   → cantidades en centésimas de la unidad del producto (entero).
 *                Ej. `1500` = `15.00 kg`.
 * - Timestamps → ISO-8601 con zona horaria (`string`).
 * - IDs        → UUIDv7 (`string`).
 */

// ---------------------------------------------------------------------------
// Errores (RFC 7807 problem+json con extensión errors[])
// ---------------------------------------------------------------------------

export interface ProblemFieldError {
  /** Causa máquina-legible, ej. "insufficient_capital". */
  code: string;
  /** Campo del request al que aplica el error, si corresponde. */
  field?: string | null;
  /** Mensaje humano-legible. */
  message: string;
}

export interface Problem {
  /** URI identificadora del tipo de problema. */
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Causas múltiples (típicamente validación de dominio, 422). */
  errors?: ProblemFieldError[];
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  access_expires_at: string;
  refresh_expires_at: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface RefreshRequest {
  refresh_token: string;
}

export interface RequestedCapacity {
  recipe_id: string;
  installations: number;
}

export interface RegisterAgentRequest {
  username: string;
  password: string;
  role: AgentRole;
  requested_capacities?: RequestedCapacity[];
}

/** Respuesta de registro: par de tokens + snapshot inicial del agente. */
export interface RegisterAgentResponse extends TokenPair {
  agent: SelfState;
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------

export type ProductCategory = "raw_primary" | "intermediate" | "final_consumption";

export interface Product {
  product_id: string;
  /** Identificador estable del catálogo (ej. `trigo`), constante entre seeds. */
  key: string;
  name: string;
  /** Unidad de medida del producto (ej. `kg`, `litro`, `cabezas`). */
  unit: string;
  category: ProductCategory;
  created_at: string;
}

export interface RecipeInput {
  product_id: string;
  /** Cantidad requerida por ejecución, en centésimas de la unidad. */
  qty_required_cent: number;
}

export interface Recipe {
  recipe_id: string;
  name: string;
  output_product_id: string;
  /** Cantidad producida por ejecución, en centésimas de la unidad. */
  output_qty_cent: number;
  /** Duración de UNA ejecución en segundos reales (no simulados). */
  duration_seconds: number;
  wage_rate_cents_per_sec: number;
  /** Vacía para recetas de producción primaria desde cero. */
  inputs: RecipeInput[];
  created_at: string;
}

// ---------------------------------------------------------------------------
// Agentes
// ---------------------------------------------------------------------------

export type AgentRole =
  | "primary_producer"
  | "transformer"
  | "consumer"
  | "trader"
  // Rol de solo-monitoreo (panel admin): no participa en el mercado.
  | "admin"
  // Banco central del patrón oro: opera la ventanilla de convertibilidad.
  | "bank";

export type AgentStatus = "active" | "bankrupt";

export interface AgentPublic {
  agent_id: string;
  username: string;
  role: AgentRole;
  status: AgentStatus;
  registered_at: string;
  bankrupt_at?: string | null;
}

export interface CapacityStatus {
  recipe_id: string;
  /** Procesos paralelos máximos para esta receta. */
  installations: number;
  /** Procesos `running` actualmente para esta receta. */
  running: number;
  /** `installations - running` (calculado por el servidor). */
  available_slots?: number;
}

export interface InventoryPosition {
  product_id: string;
  qty_available_cent: number;
  qty_reserved_cent: number;
}

export type InventoryLotOrigin = "initial" | "production" | "purchase" | "conversion";

export interface InventoryLot {
  lot_id: string;
  product_id: string;
  origin: InventoryLotOrigin;
  qty_original_cent: number;
  qty_available_cent: number;
  qty_reserved_cent: number;
  unit_cost_cents: number;
  acquired_at: string;
  source_trade_id?: string | null;
  source_process_id?: string | null;
}

/**
 * Snapshot completo y autoritativo del agente autenticado
 * (schema `AgentSnapshot` del openapi; respuesta de `GET /agents/me`).
 * Con esta carga la UI puede reanudar operación tras una reconexión.
 */
export interface SelfState {
  agent: AgentPublic;
  capital_available_cents: number;
  capital_reserved_cents: number;
  inventory: InventoryPosition[];
  /** Órdenes en estado `active` o `partial`. */
  active_orders: Order[];
  /** Procesos `running` tras materialización lazy. */
  running_processes: TransformationProcess[];
  capacities: CapacityStatus[];
  /** Resumen acotado de eventos recientes (según `events_limit`). */
  recent_events?: EventEntry[];
}

/** Alias con el nombre del schema del openapi. */
export type AgentSnapshot = SelfState;

// ---------------------------------------------------------------------------
// Órdenes
// ---------------------------------------------------------------------------

export type OrderSide = "buy" | "sell";

export type OrderStatus = "active" | "partial" | "completed" | "cancelled" | "expired";

export interface PlaceOrderRequest {
  product_id: string;
  side: OrderSide;
  /** Cantidad solicitada en centésimas. Mínimo 1. */
  qty_cent: number;
  /** Precio límite por unidad, en centavos. Mínimo 1. */
  limit_price_cents: number;
  /** TTL en segundos SIMULADOS: 60 (1 min) .. 604800 (1 semana). */
  ttl_seconds: number;
  /** Identificador opaco del cliente para idempotencia (máx. 64 chars). */
  client_order_id?: string;
}

export interface Order {
  order_id: string;
  agent_id: string;
  product_id: string;
  side: OrderSide;
  qty_original_cent: number;
  qty_pending_cent: number;
  limit_price_cents: number;
  status: OrderStatus;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

/** Respuesta de `POST /orders`: la orden + trades del primer ciclo de matching. */
export interface PlaceOrderResponse extends Order {
  trades_generated?: Trade[];
}

// ---------------------------------------------------------------------------
// Trades y mercado
// ---------------------------------------------------------------------------

export interface Trade {
  trade_id: string;
  buy_order_id: string;
  sell_order_id: string;
  buyer_agent_id: string;
  seller_agent_id: string;
  product_id: string;
  qty_executed_cent: number;
  price_cents: number;
  fee_buyer_cents: number;
  fee_seller_cents: number;
  executed_at: string;
}

export interface TopOfBookSide {
  order_id: string;
  agent_id: string;
  price_cents: number;
  qty_pending_cent: number;
}

export interface TopOfBook {
  product_id: string;
  observed_at: string;
  /** `null` si no hay órdenes de compra vigentes. */
  best_bid?: TopOfBookSide | null;
  /** `null` si no hay órdenes de venta vigentes. */
  best_ask?: TopOfBookSide | null;
}

// ---------------------------------------------------------------------------
// Transformación
// ---------------------------------------------------------------------------

export type ProcessStatus = "running" | "completed" | "cancelled";

export interface StartTransformationRequest {
  recipe_id: string;
  /** Número de ejecuciones secuenciales (≥ 1). */
  executions_planned: number;
}

export interface TransformationProcess {
  process_id: string;
  agent_id: string;
  recipe_id: string;
  executions_planned: number;
  current_execution: number;
  status: ProcessStatus;
  wage_paid_cents: number;
  started_at: string;
  expected_end_at: string;
  actual_end_at?: string | null;
}

export interface LotConsumption {
  lot_id: string;
  product_id: string;
  qty_consumed_cent: number;
  unit_cost_cents: number;
}

/** Detalle con trazabilidad: insumos consumidos y lote producido. */
export interface TransformationProcessDetail extends TransformationProcess {
  inputs_consumed?: LotConsumption[];
  /** `null` mientras el proceso está `running`. */
  produced_lot?: InventoryLot | null;
}

// ---------------------------------------------------------------------------
// Eventos / historial
// ---------------------------------------------------------------------------

export type EventType =
  | "agent_registered"
  | "agent_bankrupt"
  | "order_placed"
  | "order_cancelled"
  | "order_expired"
  | "trade_executed"
  | "process_started"
  | "process_completed"
  | "process_cancelled"
  | "snapshot_taken";

/** Schema `Event` del openapi (renombrado para no chocar con DOM `Event`). */
export interface EventEntry {
  event_id: string;
  event_type: EventType;
  /** Agente protagonista; `null` para eventos sistémicos. */
  agent_id?: string | null;
  occurred_at: string;
  /** Payload libre por `event_type`. */
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Paginación por cursor
// ---------------------------------------------------------------------------

/** Página genérica: `OrderPage`, `TradePage`, `TransformationPage`, `EventPage`. */
export interface Page<T> {
  items: T[];
  /** Cursor opaco; `null`/ausente cuando no hay más resultados. */
  next_cursor?: string | null;
}

export type OrderPage = Page<Order>;
export type TradePage = Page<Trade>;
export type TransformationPage = Page<TransformationProcess>;
export type EventPage = Page<EventEntry>;

// ---------------------------------------------------------------------------
// WebSocket (x-websocket-channel: sobre de notificación push)
// ---------------------------------------------------------------------------

export type NotificationType =
  | "order_executed"
  | "order_expired"
  | "order_cancelled"
  | "transformation_completed"
  | "bankruptcy_notice"
  | "agent_bankrupt"
  /** Broadcast por cada trade ejecutado en el mercado (payload = Trade). */
  | "trade_printed"
  /** Personal: conversión en la ventanilla del banco (payload = GoldConversion). */
  | "gold_converted";

export interface Notification {
  type: NotificationType;
  occurred_at: string;
  /** Payload tipado por `type` en la capa de aplicación (libre aquí). */
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Panel de administración / monitoreo (rol admin) — /v1/admin/*
// ---------------------------------------------------------------------------

export interface AdminKpis {
  active_agents: number;
  bankrupt_agents: number;
  total_capital_cents: number;
  fees_collected_cents: number;
  active_processes: number;
  open_orders: number;
  trade_volume_24h: number;
  trades_24h: number;
}

export interface AdminAgentsByRole {
  role: AgentRole;
  active_agents: number;
  bankrupt_agents: number;
  total_capital_cents: number;
}

export interface AdminOverview {
  kpis: AdminKpis;
  by_role: AdminAgentsByRole[];
}

export interface AdminAgentItem {
  agent_id: string;
  username: string;
  role: AgentRole;
  status: AgentStatus;
  capital_available_cents: number;
  capital_reserved_cents: number;
  registered_at: string;
}

export interface AdminAgentsPage {
  items: AdminAgentItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminMarketProduct {
  product_id: string;
  name: string;
  unit: string;
  category: string;
  best_bid_cents: number | null;
  best_ask_cents: number | null;
  bid_depth: number;
  ask_depth: number;
  total_inventory: number;
  trade_volume_24h: number;
  vwap_24h_cents: number | null;
  trades_24h: number;
}

export interface AdminProductionRecipe {
  recipe_id: string;
  recipe_name: string;
  output_product_id: string;
  output_product_name: string;
  active_processes: number;
  planned_executions: number;
  wage_paid_cents: number;
}

export interface AdminProducedProduct {
  product_id: string;
  name: string;
  unit: string;
  produced_units_24h: number;
}

export interface AdminProduction {
  recipes: AdminProductionRecipe[];
  produced: AdminProducedProduct[];
}

export interface AdminSnapshotPoint {
  snapshot_id: string;
  taken_at: string;
  active_agents: number;
  total_money_cents: number;
  fees_collected_cents: number;
}
