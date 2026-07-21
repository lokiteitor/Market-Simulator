/**
 * Cliente HTTP del E2E [M11] + tipos del contrato HTTP.
 *
 * Los tipos replican los schemas de `specs/openapi.yaml` (snake_case, el
 * openapi MANDA). NO se importan tipos del código del servidor: la suite
 * verifica el contrato, no la implementación.
 *
 * Usa fetch nativo de Bun. Toda petición tiene timeout propio (AbortSignal).
 */
import { fail } from "./framework";

// ---------------------------------------------------------------------------
// Tipos del contrato (specs/openapi.yaml, components.schemas)
// ---------------------------------------------------------------------------

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: Array<{ code: string; field?: string | null; message: string }>;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
  access_expires_at: string;
  refresh_expires_at: string;
}

export type AgentRole = "transformer" | "consumer" | "trader";

export interface AgentPublic {
  agent_id: string;
  username: string;
  role: AgentRole;
  status: "active" | "bankrupt";
  registered_at: string;
  bankrupt_at?: string | null;
}

export interface InstallationStatus {
  installation_type: string;
  name: string;
  unit_label: string;
  level: number;
  running: number;
  available_slots: number;
  next_upgrade_price_cents: number | null;
}

export interface AcquireInstallationResponse extends InstallationStatus {
  amount_charged_cents: number;
}

export interface InventoryPosition {
  product_id: string;
  qty_available_cent: number;
  qty_reserved_cent: number;
}

export interface InventoryLot {
  lot_id: string;
  product_id: string;
  origin: "initial" | "production" | "purchase";
  qty_original_cent: number;
  qty_available_cent: number;
  qty_reserved_cent: number;
  unit_cost_cents: number;
  acquired_at: string;
  source_trade_id?: string | null;
  source_process_id?: string | null;
}

export type OrderSide = "buy" | "sell";
export type OrderStatus = "active" | "partial" | "completed" | "cancelled" | "expired";

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

export interface PlaceOrderResponse extends Order {
  trades_generated?: Trade[];
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
  best_bid?: TopOfBookSide | null;
  best_ask?: TopOfBookSide | null;
}

export interface Product {
  product_id: string;
  name: string;
  unit: string;
  category: "raw_primary" | "intermediate" | "final_consumption";
  created_at: string;
}

export interface RecipeInput {
  product_id: string;
  qty_required_cent: number;
}

export interface Recipe {
  recipe_id: string;
  name: string;
  output_product_id: string;
  output_qty_cent: number;
  duration_seconds: number;
  wage_rate_cents_per_sec: number;
  inputs: RecipeInput[];
  created_at: string;
}

export type ProcessStatus = "running" | "completed" | "cancelled";

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

export interface LotConsumptionApi {
  lot_id: string;
  product_id: string;
  qty_consumed_cent: number;
  unit_cost_cents: number;
}

export interface TransformationProcessDetail extends TransformationProcess {
  inputs_consumed?: LotConsumptionApi[];
  produced_lot?: InventoryLot | null;
}

export interface EventItem {
  event_id: string;
  event_type: string;
  agent_id?: string | null;
  occurred_at: string;
  payload: Record<string, unknown>;
}

export interface AgentSnapshot {
  agent: AgentPublic;
  capital_available_cents: number;
  capital_reserved_cents: number;
  inventory: InventoryPosition[];
  active_orders: Order[];
  running_processes: TransformationProcess[];
  installations: InstallationStatus[];
  recent_events?: EventItem[];
}

export interface RegisterAgentResponse extends TokenPair {
  agent: AgentSnapshot;
}

export interface Page<T> {
  items: T[];
  next_cursor?: string | null;
}

// ---------------------------------------------------------------------------
// Cliente HTTP
// ---------------------------------------------------------------------------

export interface ApiResponse<T = unknown> {
  status: number;
  contentType: string;
  body: T;
}

export interface RequestOpts {
  token?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
}

/** Presupuesto de llamadas a /v1/auth/*: la suite cuenta sus llamadas localmente. */
export let authCallCount = 0;

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  async request<T = unknown>(method: string, path: string, opts: RequestOpts = {}): Promise<ApiResponse<T>> {
    const url = new URL(this.baseUrl + path);
    if (opts.query !== undefined) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    if (path.startsWith("/auth/")) {
      authCallCount += 1;
      if (authCallCount > 9) {
        // Presupuesto del contrato: POCAS llamadas de auth (límite de control local de la suite).
        fail(`presupuesto de llamadas /auth/* excedido (${authCallCount}) en la suite de pruebas`);
      }
    }
    const headers: Record<string, string> = {
      accept: "application/json, application/problem+json",
    };
    if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
    let bodyStr: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      bodyStr = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: bodyStr,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      fail(`${method} ${url.pathname}: fetch falló (${err instanceof Error ? err.message : String(err)})`);
    }

    if (res.status === 429) {
      fail(`${method} ${url.pathname}: 429 rate limit excedido en el Gateway.`);
    }

    const raw = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    let body: unknown = null;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    return { status: res.status, contentType, body: body as T };
  }

  get<T = unknown>(path: string, opts: RequestOpts = {}): Promise<ApiResponse<T>> {
    return this.request<T>("GET", path, opts);
  }

  post<T = unknown>(path: string, opts: RequestOpts = {}): Promise<ApiResponse<T>> {
    return this.request<T>("POST", path, opts);
  }

  delete<T = unknown>(path: string, opts: RequestOpts = {}): Promise<ApiResponse<T>> {
    return this.request<T>("DELETE", path, opts);
  }
}

// ---------------------------------------------------------------------------
// Helpers de aserción sobre respuestas
// ---------------------------------------------------------------------------

function bodyExcerpt(body: unknown): string {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return s === undefined ? "(sin body)" : s.slice(0, 600);
}

/** Falla con contexto si el status no coincide; devuelve el body tipado. */
export function expectStatus<T>(resp: ApiResponse<unknown>, expected: number, label: string): T {
  if (resp.status !== expected) {
    fail(`${label}: status esperado ${expected}, recibido ${resp.status}. Body: ${bodyExcerpt(resp.body)}`);
  }
  return resp.body as T;
}

function kebab(code: string): string {
  return code.replaceAll("_", "-");
}

/**
 * Verifica una respuesta de error RFC 7807 (contrato §6 + openapi Problem):
 * content-type `application/problem+json`, campos requeridos, status coherente
 * y —si se pide `code`— que el problema lo identifique, sea vía
 * `type: https://errors.mercado-agricola/<code-kebab>` o vía `errors[].code`.
 */
export function expectProblem(
  resp: ApiResponse<unknown>,
  expectedStatus: number,
  label: string,
  opts: { code?: string } = {},
): Problem {
  if (resp.status !== expectedStatus) {
    fail(`${label}: status esperado ${expectedStatus}, recibido ${resp.status}. Body: ${bodyExcerpt(resp.body)}`);
  }
  if (!resp.contentType.includes("application/problem+json")) {
    fail(`${label}: content-type esperado application/problem+json, recibido "${resp.contentType}"`);
  }
  const p = resp.body as Problem;
  if (typeof p !== "object" || p === null || typeof p.type !== "string" || typeof p.title !== "string") {
    fail(`${label}: body no tiene forma Problem (type/title/status). Body: ${bodyExcerpt(resp.body)}`);
  }
  if (p.status !== expectedStatus) {
    fail(`${label}: Problem.status esperado ${expectedStatus}, recibido ${p.status}`);
  }
  if (opts.code !== undefined) {
    const inType = p.type.endsWith(`/${kebab(opts.code)}`);
    const inErrors = Array.isArray(p.errors) && p.errors.some((e) => e.code === opts.code);
    if (!inType && !inErrors) {
      fail(
        `${label}: se esperaba código "${opts.code}" en Problem.type (…/${kebab(opts.code)}) ` +
          `o en errors[].code. Body: ${bodyExcerpt(resp.body)}`,
      );
    }
  }
  return p;
}
