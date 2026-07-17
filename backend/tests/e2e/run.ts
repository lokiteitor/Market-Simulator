/**
 * Suite E2E [M11] — Simulación de Mercado Agrícola (contrato §18).
 *
 * Ejecutar:  bun tests/e2e/run.ts          (cwd = backend/)
 * Contra:    Caddy (E2E_BASE_URL, default http://localhost:9080/v1);
 *            WS derivado: ws(s)://…/v1/ws?token=<access>.
 *
 * La suite verifica el CONTRATO (specs/openapi.yaml + CONTRATOS §5/§9/§10/§18),
 * no la implementación. Las expectativas numéricas de fees/lotes/COGS/salarios
 * se calculan con las MISMAS funciones del servidor (src/lib/money, src/lib/simtime
 * vía tests/e2e/expected.ts) — si el servidor corre con fees/factor distintos,
 * exporta las mismas env vars al invocar la suite.
 *
 * Política de fallo: ABORTA AL PRIMER FALLO (pasos secuenciales dependientes),
 * imprime resumen y sale con exit code 1; si todo pasa, exit 0 (framework.ts).
 *
 * Presupuesto de auth: Aunque Caddy no tiene rate limit activo, la suite
 * registra SOLO 2 agentes y hace 6 llamadas de auth en total (2 register,
 * 1 login, 1 refresh, 1 logout, 1 refresh-revocado) para controlar el presupuesto
 * local de llamadas. Reutiliza tokens en todo lo demás.
 *
 * Precondiciones: stack de infra/docker-compose.yml arriba y seed [M9] aplicado
 * (el catálogo debe existir). El libro de `germinado` debe estar limpio; las
 * órdenes de la suite usan TTLs cortos (≤ 300 sim-s = 60 s reales con factor 5)
 * y se cancelan al final, así una corrida fallida se auto-limpia en ~1 min.
 */
import {
  ApiClient,
  authCallCount,
  expectProblem,
  expectStatus,
  type AgentRole,
  type AgentSnapshot,
  type EventItem,
  type InventoryLot,
  type InventoryPosition,
  type Order,
  type Page,
  type PlaceOrderResponse,
  type Product,
  type Recipe,
  type RegisterAgentResponse,
  type TokenPair,
  type TopOfBook,
  type Trade,
  type TransformationProcess,
  type TransformationProcessDetail,
} from "./client";
import {
  config,
  expectedPrimaryProcessNumbers,
  expectedTradeNumbers,
  notionalCents,
  simSecondsToRealMs,
} from "./expected";
import {
  assert,
  assertClose,
  assertEqual,
  assertOneOf,
  fail,
  finishAndExit,
  onCleanup,
  pollUntil,
  startWatchdog,
  step,
} from "./framework";
import { FAST_RECIPE_KEY, loadSeedConfig, seedProduct, seedRecipe, type SeedConfig } from "./seed-config";
import { WsClient } from "./ws";

// ---------------------------------------------------------------------------
// Entorno
// ---------------------------------------------------------------------------

const BASE_URL = (process.env.E2E_BASE_URL ?? "http://localhost:9080/v1").replace(/\/$/, "");
const WS_BASE = BASE_URL.replace(/^http/, "ws"); // http→ws, https→wss
const api = new ApiClient(BASE_URL);

const runId = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
const PASSWORD = "e2e-Password-12345";

/** TTL de las órdenes de trabajo: 300 sim-s (= 60 s reales con factor 5). */
const MAIN_TTL_SIM_S = 300;
/** TTL del test de expiración: mínimo del contrato (60 sim-s = 12 s reales). */
const EXPIRY_TTL_SIM_S = 60;

const SELL_LIMIT_CENTS = 500;
const BUY_LIMIT_CENTS = 520;

interface AgentCtx {
  label: string;
  username: string;
  role: AgentRole;
  agentId: string;
  accessToken: string;
  refreshToken: string;
  seedCapitalCents: number;
  ws: WsClient | null;
}

// Órdenes propias aún abiertas (para cleanup best-effort al salir).
const openOrders = new Map<string, AgentCtx>();
function trackOrder(orderId: string, agent: AgentCtx): void {
  openOrders.set(orderId, agent);
}
function untrackOrder(orderId: string): void {
  openOrders.delete(orderId);
}

// ---------------------------------------------------------------------------
// Helpers de dominio
// ---------------------------------------------------------------------------

async function me(agent: AgentCtx): Promise<AgentSnapshot> {
  return expectStatus<AgentSnapshot>(
    await api.get("/agents/me", { token: agent.accessToken }),
    200,
    `GET /agents/me (${agent.label})`,
  );
}

function totalCapital(s: AgentSnapshot): number {
  return s.capital_available_cents + s.capital_reserved_cents;
}

/** Posición de inventario de un producto (ceros si no hay posición). */
async function positionOf(agent: AgentCtx, productId: string): Promise<InventoryPosition> {
  const positions = expectStatus<InventoryPosition[]>(
    await api.get("/agents/me/inventory", { token: agent.accessToken, query: { product_id: productId } }),
    200,
    `GET /agents/me/inventory (${agent.label})`,
  );
  return (
    positions.find((p) => p.product_id === productId) ?? {
      product_id: productId,
      qty_available_cent: 0,
      qty_reserved_cent: 0,
    }
  );
}

async function lotsOf(agent: AgentCtx, productId: string): Promise<InventoryLot[]> {
  return expectStatus<InventoryLot[]>(
    await api.get("/agents/me/inventory/lots", {
      token: agent.accessToken,
      query: { product_id: productId, only_with_stock: false },
    }),
    200,
    `GET /agents/me/inventory/lots (${agent.label})`,
  );
}

interface PlaceOrderBody {
  product_id: string;
  side: "buy" | "sell";
  qty_cent: number;
  limit_price_cents: number;
  ttl_seconds: number;
  client_order_id?: string;
}

async function placeOrder(agent: AgentCtx, body: PlaceOrderBody, label: string): Promise<PlaceOrderResponse> {
  const order = expectStatus<PlaceOrderResponse>(
    await api.post("/orders", { token: agent.accessToken, body }),
    201,
    label,
  );
  if (order.status === "active" || order.status === "partial") trackOrder(order.order_id, agent);
  return order;
}

async function cancelOrder(agent: AgentCtx, orderId: string, label: string): Promise<void> {
  const resp = await api.delete(`/orders/${orderId}`, { token: agent.accessToken });
  expectStatus<null>(resp, 204, label);
  untrackOrder(orderId);
}

/** Pagina /history/trades del agente hasta agotar el cursor. */
async function allHistoryTrades(agent: AgentCtx): Promise<Trade[]> {
  const items: Trade[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const body = expectStatus<Page<Trade>>(
      await api.get("/history/trades", {
        token: agent.accessToken,
        query: { limit: 200, cursor },
      }),
      200,
      `GET /history/trades (${agent.label})`,
    );
    items.push(...body.items);
    if (body.next_cursor === null || body.next_cursor === undefined) return items;
    cursor = body.next_cursor;
  }
  fail(`GET /history/trades (${agent.label}): más de 20 páginas; ¿cursor sin avance?`);
}

/** Pagina GET /transformations del agente (todos los status). */
async function allProcesses(agent: AgentCtx): Promise<TransformationProcess[]> {
  const items: TransformationProcess[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const body = expectStatus<Page<TransformationProcess>>(
      await api.get("/transformations", {
        token: agent.accessToken,
        query: { limit: 200, cursor },
      }),
      200,
      `GET /transformations (${agent.label})`,
    );
    items.push(...body.items);
    if (body.next_cursor === null || body.next_cursor === undefined) return items;
    cursor = body.next_cursor;
  }
  fail(`GET /transformations (${agent.label}): más de 20 páginas; ¿cursor sin avance?`);
}

function wsTradeId(payload: Record<string, unknown>): string | undefined {
  if (typeof payload["trade_id"] === "string") return payload["trade_id"];
  const nested = payload["trade"];
  if (typeof nested === "object" && nested !== null) {
    const tid = (nested as Record<string, unknown>)["trade_id"];
    if (typeof tid === "string") return tid;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`E2E mercado-agricola — base: ${BASE_URL} (run ${runId})`);
  startWatchdog(300_000);
  onCleanup("cancelar órdenes residuales de la suite", async () => {
    for (const [orderId, agent] of openOrders) {
      try {
        await api.delete(`/orders/${orderId}`, { token: agent.accessToken });
      } catch {
        // best-effort: los TTL cortos limpian lo que quede
      }
    }
  });

  // ---- 1. Configuración semilla (sin API) ---------------------------------

  const seedCfg: SeedConfig = await step("1. seed-config: cargar infra/seed-config.json", async () => {
    const cfg = await loadSeedConfig();
    const fast = seedRecipe(cfg, FAST_RECIPE_KEY);
    assertEqual(fast.inputs.length, 0, `receta ${FAST_RECIPE_KEY} debe ser primaria (sin insumos)`);
    assert(
      cfg.roles["primary_producer"]?.capacities.some((c) => c.recipe === FAST_RECIPE_KEY),
      `el rol primary_producer debe tener capacidad para ${FAST_RECIPE_KEY} en seed-config`,
    );
    return cfg;
  });
  const fastSeedRecipe = seedRecipe(seedCfg, FAST_RECIPE_KEY);
  const fastSeedProduct = seedProduct(seedCfg, fastSeedRecipe.output);

  // ---- 2. Reachability -----------------------------------------------------

  await step("2. API accesible (GET /catalog/products vía Caddy)", async () => {
    await pollUntil(
      `${BASE_URL}/catalog/products responde 200`,
      async () => {
        try {
          const r = await api.get("/catalog/products");
          return r.status === 200 ? true : undefined;
        } catch {
          return undefined;
        }
      },
      { timeoutMs: 60_000, initialDelayMs: 1_000, maxDelayMs: 5_000 },
    );
  });

  // ---- 3. Catálogo ----------------------------------------------------------

  const { products, recipes } = await step("3. catálogo: productos y recetas (público)", async () => {
    const prods = expectStatus<Product[]>(await api.get("/catalog/products"), 200, "GET /catalog/products");
    const recs = expectStatus<Recipe[]>(await api.get("/catalog/recipes"), 200, "GET /catalog/recipes");
    // Todo el seed-config debe estar en el catálogo (¿corrió el seed [M9]?).
    for (const sp of seedCfg.products) {
      assert(
        prods.some((p) => p.name === sp.name),
        `producto del seed "${sp.name}" ausente del catálogo — ¿corrió el seed?`,
      );
    }
    for (const sr of seedCfg.recipes) {
      assert(
        recs.some((r) => r.name === sr.name),
        `receta del seed "${sr.name}" ausente del catálogo — ¿corrió el seed?`,
      );
    }
    return { products: prods, recipes: recs };
  });

  const germProduct = products.find((p) => p.name === fastSeedProduct.name);
  assert(germProduct !== undefined, `producto "${fastSeedProduct.name}" no encontrado en catálogo`);
  const fastRecipe = recipes.find((r) => r.name === fastSeedRecipe.name);
  assert(fastRecipe !== undefined, `receta "${fastSeedRecipe.name}" no encontrada en catálogo`);
  const recipeIdByName = new Map(recipes.map((r) => [r.name, r.recipe_id]));

  await step("4. catálogo: detalle de producto y receta coherentes con seed-config", async () => {
    const p = expectStatus<Product>(
      await api.get(`/catalog/products/${germProduct.product_id}`),
      200,
      "GET /catalog/products/{id}",
    );
    assertEqual(p.product_id, germProduct.product_id, "product_id del detalle");
    assertEqual(p.unit, fastSeedProduct.unit, "unit del producto");
    assertEqual(p.category, fastSeedProduct.category as Product["category"], "category del producto");

    const r = expectStatus<Recipe>(
      await api.get(`/catalog/recipes/${fastRecipe.recipe_id}`),
      200,
      "GET /catalog/recipes/{id}",
    );
    assertEqual(r.recipe_id, fastRecipe.recipe_id, "recipe_id del detalle");
    assertEqual(r.output_product_id, germProduct.product_id, "output_product_id de la receta rápida");
    assertEqual(r.output_qty_cent, fastSeedRecipe.output_qty_cent, "output_qty_cent");
    // openapi: Recipe.duration_seconds está en segundos REALES (no simulados);
    // el seed-config declara la duración en segundos simulados.
    assertEqual(
      r.duration_seconds,
      Math.round(simSecondsToRealMs(fastSeedRecipe.duration_sim_seconds) / 1000),
      "duration_seconds (reales)",
    );
    assertEqual(r.wage_rate_cents_per_sec, fastSeedRecipe.wage_rate_cents_per_sec, "wage_rate_cents_per_sec");
    assertEqual(r.inputs.length, 0, "receta rápida sin insumos");

    // 404 Problem+JSON con UUID inexistente.
    expectProblem(
      await api.get(`/catalog/products/00000000-0000-7000-8000-000000000000`),
      404,
      "GET /catalog/products/{uuid inexistente}",
    );
  });

  // ---- 5-6. Registro de agentes (2 llamadas de auth) -----------------------

  async function registerAgent(label: string, role: AgentRole): Promise<AgentCtx> {
    const username = `e2e_${runId}_${label}`;
    const body = expectStatus<RegisterAgentResponse>(
      await api.post("/auth/register", { body: { username, password: PASSWORD, role } }),
      201,
      `POST /auth/register (${label})`,
    );
    assert(typeof body.access_token === "string" && body.access_token.length > 0, "access_token presente");
    assert(typeof body.refresh_token === "string" && body.refresh_token.length > 0, "refresh_token presente");
    assertEqual(body.token_type, "Bearer", "token_type");
    assert(!Number.isNaN(Date.parse(body.access_expires_at)), "access_expires_at es fecha ISO");
    assert(!Number.isNaN(Date.parse(body.refresh_expires_at)), "refresh_expires_at es fecha ISO");
    // El capital semilla se acredita de forma ASÍNCRONA (cola gold-issuance del
    // Worker), así que la respuesta del registro trae capital 0; se espera con
    // poll a GET /agents/me hasta verlo acreditado.
    const snap = await pollUntil(
      `capital semilla de ${label} acreditado`,
      async () => {
        const s = expectStatus<AgentSnapshot>(
          await api.get("/agents/me", { token: body.access_token }),
          200,
          `GET /agents/me (${label})`,
        );
        return s.capital_available_cents > 0 ? s : undefined;
      },
    );
    assertEqual(snap.agent.username, username, "username del snapshot");
    assertEqual(snap.agent.role, role, "role del snapshot");
    assertEqual(snap.agent.status, "active", "status del snapshot");
    assert(snap.capital_available_cents > 0, "capital semilla > 0");
    assertEqual(snap.capital_reserved_cents, 0, "capital reservado inicial = 0");
    assertEqual(snap.inventory.length, 0, "inventario inicial vacío (§13: capital solamente)");
    assertEqual(snap.active_orders.length, 0, "sin órdenes al registrarse");
    assertEqual(snap.running_processes.length, 0, "sin procesos al registrarse");
    return {
      label,
      username,
      role,
      agentId: snap.agent.agent_id,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      seedCapitalCents: snap.capital_available_cents + snap.capital_reserved_cents,
      ws: null,
    };
  }

  const alice = await step("5. auth: registrar ALICE (primary_producer) con capacidades del rol", async () => {
    const agent = await registerAgent("prod", "primary_producer");
    // §10.12: el registro por rol asigna las capacidades del rol de seed-config.
    const snap = await me(agent);
    const roleCaps = seedCfg.roles["primary_producer"]?.capacities ?? [];
    assertEqual(snap.capacities.length, roleCaps.length, "número de capacidades del rol primary_producer");
    for (const cap of roleCaps) {
      const recipeName = seedRecipe(seedCfg, cap.recipe).name;
      const recipeId = recipeIdByName.get(recipeName);
      assert(recipeId !== undefined, `receta de capacidad "${recipeName}" en catálogo`);
      const found = snap.capacities.find((c) => c.recipe_id === recipeId);
      assert(found !== undefined, `capacidad para "${cap.recipe}" asignada al registrarse`);
      assertEqual(found.installations, cap.installations, `installations de "${cap.recipe}"`);
      assertEqual(found.running, 0, `running inicial de "${cap.recipe}"`);
    }
    return agent;
  });

  const bob = await step("6. auth: registrar BOB (trader) sin capacidades", async () => {
    const agent = await registerAgent("trader", "trader");
    const snap = await me(agent);
    assertEqual(snap.capacities.length, 0, "el rol trader no tiene capacidades en seed-config");
    return agent;
  });

  // ---- 7-9. Login / refresh / logout (4 llamadas de auth) ------------------

  await step("7. auth: login de ALICE", async () => {
    const pair = expectStatus<TokenPair>(
      await api.post("/auth/login", { body: { username: alice.username, password: PASSWORD } }),
      200,
      "POST /auth/login",
    );
    assertEqual(pair.token_type, "Bearer", "token_type del login");
    // El access recién emitido funciona.
    const snap = expectStatus<AgentSnapshot>(
      await api.get("/agents/me", { token: pair.access_token }),
      200,
      "GET /agents/me con access del login",
    );
    assertEqual(snap.agent.agent_id, alice.agentId, "identidad del login");
    alice.accessToken = pair.access_token;
    alice.refreshToken = pair.refresh_token;
  });

  await step("8. auth: refresh con rotación (ALICE)", async () => {
    const oldRefresh = alice.refreshToken;
    const pair = expectStatus<TokenPair>(
      await api.post("/auth/refresh", { body: { refresh_token: oldRefresh } }),
      200,
      "POST /auth/refresh",
    );
    assert(pair.refresh_token !== oldRefresh, "el refresh token debe rotar");
    assert(pair.access_token.length > 0, "nuevo access presente");
    alice.accessToken = pair.access_token;
    alice.refreshToken = pair.refresh_token;
  });

  await step("9. auth: logout revoca el refresh; el access sigue vigente (stateless)", async () => {
    expectStatus<null>(
      await api.post("/auth/logout", {
        token: alice.accessToken,
        body: { refresh_token: alice.refreshToken },
      }),
      204,
      "POST /auth/logout",
    );
    // El refresh revocado ya no sirve (401 invalid_token).
    expectProblem(
      await api.post("/auth/refresh", { body: { refresh_token: alice.refreshToken } }),
      401,
      "POST /auth/refresh con token revocado",
      { code: "invalid_token" },
    );
    // El access token es stateless: sigue funcionando hasta expirar.
    expectStatus<AgentSnapshot>(
      await api.get("/agents/me", { token: alice.accessToken }),
      200,
      "GET /agents/me tras logout (access stateless)",
    );
    console.log(`  (llamadas /auth/* usadas: ${authCallCount}/10 por minuto)`);
  });

  // ---- 10. WebSocket para 2 agentes ----------------------------------------

  await step("10. ws: conectar 2 agentes (?token=<access>)", async () => {
    const wsAlice = new WsClient(`${WS_BASE}/ws?token=${encodeURIComponent(alice.accessToken)}`, "alice");
    const wsBob = new WsClient(`${WS_BASE}/ws?token=${encodeURIComponent(bob.accessToken)}`, "bob");
    onCleanup("cerrar WebSockets", () => {
      wsAlice.close();
      wsBob.close();
    });
    await wsAlice.connect();
    await wsBob.connect();
    assert(wsAlice.isOpen, "WS de alice abierto");
    assert(wsBob.isOpen, "WS de bob abierto");
    alice.ws = wsAlice;
    bob.ws = wsBob;
  });
  const wsAlice = alice.ws;
  const wsBob = bob.ws;
  assert(wsAlice !== null && wsBob !== null, "WS conectados");

  // ---- 11-13. Transformación germinado_rapido ------------------------------

  const EXECUTIONS = 1;
  const procExp = expectedPrimaryProcessNumbers({
    durationSimSeconds: fastSeedRecipe.duration_sim_seconds,
    wageRateCentsPerSec: fastSeedRecipe.wage_rate_cents_per_sec,
    outputQtyCent: fastSeedRecipe.output_qty_cent,
    executions: EXECUTIONS,
  });
  const producedQty = procExp.producedQtyCent;
  assert(producedQty >= 5, `output de ${FAST_RECIPE_KEY} demasiado pequeño para el escenario (${producedQty})`);

  const proc = await step(
    `11. transformación: iniciar ${FAST_RECIPE_KEY} (salario upfront = ${procExp.wageCents}c)`,
    async () => {
      const before = await me(alice);
      const p = expectStatus<TransformationProcess>(
        await api.post("/transformations", {
          token: alice.accessToken,
          body: { recipe_id: fastRecipe.recipe_id, executions_planned: EXECUTIONS },
        }),
        201,
        "POST /transformations",
      );
      assertEqual(p.status, "running", "status del proceso");
      assertEqual(p.agent_id, alice.agentId, "agent_id del proceso");
      assertEqual(p.recipe_id, fastRecipe.recipe_id, "recipe_id del proceso");
      assertEqual(p.executions_planned, EXECUTIONS, "executions_planned");
      assertEqual(p.wage_paid_cents, procExp.wageCents, "wage_paid_cents (§4: rate × dur_sim × exec)");
      assertClose(
        Date.parse(p.expected_end_at),
        Date.parse(p.started_at) + procExp.totalRealDurationMs,
        1_500,
        "expected_end_at = started_at + dur_sim×exec / factor",
      );
      const after = await me(alice);
      assertEqual(
        after.capital_available_cents,
        before.capital_available_cents - procExp.wageCents,
        "capital tras salario upfront",
      );
      assert(
        after.running_processes.some((rp) => rp.process_id === p.process_id),
        "el proceso aparece en running_processes del snapshot",
      );
      return p;
    },
  );

  await step(
    `12. transformación: materialización (~${Math.round(procExp.totalRealDurationMs / 1000)} s reales)`,
    async () => {
      const d = await pollUntil(
        `proceso ${proc.process_id} en status completed`,
        async () => {
          const resp = expectStatus<TransformationProcessDetail>(
            await api.get(`/transformations/${proc.process_id}`, { token: alice.accessToken }),
            200,
            "GET /transformations/{id}",
          );
          return resp.status === "completed" ? resp : undefined;
        },
        {
          timeoutMs: procExp.totalRealDurationMs + config.sweeps.transformationIntervalMs + 25_000,
          initialDelayMs: 1_000,
          maxDelayMs: 3_000,
        },
      );
      assertEqual(d.current_execution, EXECUTIONS, "current_execution persistido = executions_planned");
      assert(d.actual_end_at !== null && d.actual_end_at !== undefined, "actual_end_at asignado");
      const lot = d.produced_lot;
      assert(lot !== null && lot !== undefined, "produced_lot presente al completar");
      assertEqual(lot.origin, "production", "origin del lote producido");
      assertEqual(lot.product_id, germProduct.product_id, "producto del lote producido");
      assertEqual(lot.qty_original_cent, producedQty, "qty producida = output_qty × executions");
      assertEqual(lot.qty_available_cent, producedQty, "lote producido disponible");
      assertEqual(lot.qty_reserved_cent, 0, "lote producido sin reservas");
      assertEqual(
        lot.unit_cost_cents,
        procExp.producedLotUnitCostCents,
        "COGS producción: unit_cost = (insumos + salario) / qty",
      );
      assertEqual(lot.source_process_id ?? null, proc.process_id, "source_process_id del lote");
      assertEqual((d.inputs_consumed ?? []).length, 0, "receta primaria: sin insumos consumidos");
      // Posición agregada.
      const pos = await positionOf(alice, germProduct.product_id);
      assertEqual(pos.qty_available_cent, producedQty, "posición disponible tras materializar");
      assertEqual(pos.qty_reserved_cent, 0, "posición sin reservas tras materializar");
    },
  );

  await step("13. ws: notificación transformation_completed (ALICE)", async () => {
    const n = await wsAlice.waitFor(
      "transformation_completed del proceso",
      (m) => m.type === "transformation_completed",
      30_000,
    );
    assert(typeof n.occurred_at === "string" && !Number.isNaN(Date.parse(n.occurred_at)), "occurred_at ISO");
    const pid = n.payload["process_id"];
    if (pid !== undefined) assertEqual(pid, proc.process_id, "payload.process_id");
  });

  // ---- 14-18. Mercado: sell + buy cruzadas, trade verificado ----------------

  await step(`14. mercado: libro de ${fastSeedProduct.name} limpio (precondición)`, async () => {
    const top = expectStatus<TopOfBook>(
      await api.get(`/market/${germProduct.product_id}/top`, { token: bob.accessToken }),
      200,
      "GET /market/{id}/top",
    );
    assert(
      (top.best_bid ?? null) === null && (top.best_ask ?? null) === null,
      `el libro de ${fastSeedProduct.name} tiene órdenes residuales (bid=${JSON.stringify(top.best_bid)}, ` +
        `ask=${JSON.stringify(top.best_ask)}); espera ~1 min a que expiren TTLs de corridas previas`,
    );
  });

  const sellQty = producedQty; // 1000 con el seed-config actual
  const buyQty = Math.max(1, Math.floor((sellQty * 2) / 5)); // 400
  const remainingQty = sellQty - buyQty; // 600
  assert(remainingQty >= 1, "el escenario requiere fill parcial del sell");
  const tradeExp = expectedTradeNumbers(buyQty, SELL_LIMIT_CENTS);

  const sellOrder = await step(
    `15. órdenes: SELL de ALICE ${sellQty}q @ ${SELL_LIMIT_CENTS}c (reserva FIFO de inventario)`,
    async () => {
      const o = await placeOrder(
        alice,
        {
          product_id: germProduct.product_id,
          side: "sell",
          qty_cent: sellQty,
          limit_price_cents: SELL_LIMIT_CENTS,
          ttl_seconds: MAIN_TTL_SIM_S,
        },
        "POST /orders (sell alice)",
      );
      assertEqual(o.status, "active", "sell activa (libro vacío)");
      assertEqual(o.qty_pending_cent, sellQty, "qty_pending de la sell");
      assertEqual((o.trades_generated ?? []).length, 0, "sin trades al insertar la sell");
      assertClose(
        Date.parse(o.expires_at),
        Date.parse(o.created_at) + simSecondsToRealMs(MAIN_TTL_SIM_S),
        1_500,
        "expires_at aplica el factor de simulación al TTL",
      );
      const pos = await positionOf(alice, germProduct.product_id);
      assertEqual(pos.qty_reserved_cent, sellQty, "inventario reservado por la sell");
      assertEqual(pos.qty_available_cent, 0, "inventario disponible tras reservar");
      const lots = await lotsOf(alice, germProduct.product_id);
      const prodLot = lots.find((l) => l.origin === "production");
      assert(prodLot !== undefined, "lote production visible en /inventory/lots");
      assertEqual(prodLot.qty_reserved_cent, sellQty, "reserva FIFO aplicada al lote");
      return o;
    },
  );

  await step("16. mercado: top-of-book muestra el ask de ALICE", async () => {
    // El top-of-book se sirve con read-cache (TOP_OF_BOOK_TTL_MS ~2.5s); tras
    // colocar la sell se poll-ea hasta que el ask entra al cachear de nuevo.
    const top = await pollUntil(
      "best_ask de ALICE visible en el top-of-book",
      async () => {
        const t = expectStatus<TopOfBook>(
          await api.get(`/market/${germProduct.product_id}/top`, { token: bob.accessToken }),
          200,
          "GET /market/{id}/top",
        );
        return t.best_ask !== null && t.best_ask !== undefined ? t : undefined;
      },
    );
    assertEqual(top.product_id, germProduct.product_id, "product_id del top");
    assert((top.best_bid ?? null) === null, "sin bids");
    const ask = top.best_ask;
    assert(ask !== null && ask !== undefined, "best_ask presente");
    assertEqual(ask.order_id, sellOrder.order_id, "best_ask.order_id");
    assertEqual(ask.agent_id, alice.agentId, "best_ask.agent_id (visibilidad nivel 1)");
    assertEqual(ask.price_cents, SELL_LIMIT_CENTS, "best_ask.price_cents");
    assertEqual(ask.qty_pending_cent, sellQty, "best_ask.qty_pending_cent");
  });

  const { buyOrder, mainTrade } = await step(
    `17. órdenes: BUY cruzada de BOB ${buyQty}q @ ${BUY_LIMIT_CENTS}c → trade a ${SELL_LIMIT_CENTS}c ` +
      `(cost=${tradeExp.costCents}c, fee=${tradeExp.feePerSideCents}c/lado, lote=${tradeExp.buyerLotUnitCostCents}c/u)`,
    async () => {
      const aliceBefore = await me(alice);
      const bobBefore = await me(bob);
      // Saldo del banco ANTES: los fees deben acreditarse al banco (vía
      // fee_ledger, ADR-019). GET /bank suma los fees pendientes, así que el
      // delta es visible de inmediato sin esperar al sweeper.
      const bankBefore = expectStatus<{ bank_capital_available_cents: number }>(
        await api.get("/bank", { token: alice.accessToken }),
        200,
        "GET /bank (antes del trade)",
      );
      const o = await placeOrder(
        bob,
        {
          product_id: germProduct.product_id,
          side: "buy",
          qty_cent: buyQty,
          limit_price_cents: BUY_LIMIT_CENTS,
          ttl_seconds: MAIN_TTL_SIM_S,
        },
        "POST /orders (buy bob)",
      );
      assertEqual(o.status, "completed", "buy completada por matching inmediato");
      assertEqual(o.qty_pending_cent, 0, "qty_pending de la buy");
      untrackOrder(o.order_id);
      const trades = o.trades_generated ?? [];
      assertEqual(trades.length, 1, "un solo trade generado");
      const trade = trades[0];
      assert(trade !== undefined, "trade presente");
      // Verificación NUMÉRICA §5 (reglas importadas de src/lib/money).
      assertEqual(trade.price_cents, SELL_LIMIT_CENTS, "precio efectivo = precio de la orden PASIVA (§10.1)");
      assertEqual(trade.qty_executed_cent, buyQty, "qty ejecutada");
      assertEqual(trade.product_id, germProduct.product_id, "producto del trade");
      assertEqual(trade.buyer_agent_id, bob.agentId, "buyer_agent_id");
      assertEqual(trade.seller_agent_id, alice.agentId, "seller_agent_id");
      assertEqual(trade.buy_order_id, o.order_id, "buy_order_id");
      assertEqual(trade.sell_order_id, sellOrder.order_id, "sell_order_id");
      assertEqual(trade.fee_buyer_cents, tradeExp.feePerSideCents, "fee_buyer = fixed + notional×bps");
      assertEqual(trade.fee_seller_cents, tradeExp.feePerSideCents, "fee_seller = fixed + notional×bps");

      // Capital de ambos lados (Δ exactos; reservas del buy liberadas por telescopio).
      const aliceAfter = await me(alice);
      const bobAfter = await me(bob);
      assertEqual(
        totalCapital(bobAfter),
        totalCapital(bobBefore) + tradeExp.buyerCapitalDeltaCents,
        "capital comprador: −cost − fee",
      );
      assertEqual(bobAfter.capital_reserved_cents, 0, "reserva del comprador liberada al 100% (telescopio §5)");
      assertEqual(
        totalCapital(aliceAfter),
        totalCapital(aliceBefore) + tradeExp.sellerCapitalDeltaCents,
        "capital vendedor: +cost − fee",
      );

      // Los fees de AMBOS lados se acreditan al banco central (ADR-019): el
      // saldo del banco sube exactamente fee_buyer + fee_seller (fee_ledger +
      // suma de pendientes en GET /bank, sin esperar al sweeper).
      const bankAfter = expectStatus<{ bank_capital_available_cents: number }>(
        await api.get("/bank", { token: alice.accessToken }),
        200,
        "GET /bank (tras el trade)",
      );
      assertEqual(
        bankAfter.bank_capital_available_cents,
        bankBefore.bank_capital_available_cents + trade.fee_buyer_cents + trade.fee_seller_cents,
        "capital del banco: + (fee_buyer + fee_seller)",
      );

      // Orden pasiva queda partial con el resto.
      const sellNow = expectStatus<Order>(
        await api.get(`/orders/${sellOrder.order_id}`, { token: alice.accessToken }),
        200,
        "GET /orders/{sell}",
      );
      assertEqual(sellNow.status, "partial", "sell parcial tras el fill");
      assertEqual(sellNow.qty_pending_cent, remainingQty, "qty_pending restante de la sell");

      // Lote purchase del comprador (COGS de compra).
      const bobLots = await lotsOf(bob, germProduct.product_id);
      assertEqual(bobLots.length, 1, "un lote purchase para bob");
      const bLot = bobLots[0];
      assert(bLot !== undefined, "lote de bob presente");
      assertEqual(bLot.origin, "purchase", "origin del lote del comprador");
      assertEqual(bLot.qty_original_cent, buyQty, "qty del lote del comprador");
      assertEqual(bLot.qty_available_cent, buyQty, "lote del comprador disponible");
      assertEqual(
        bLot.unit_cost_cents,
        tradeExp.buyerLotUnitCostCents,
        "unit_cost del lote purchase = (cost + fee_buyer) / qty (§5)",
      );
      assertEqual(bLot.source_trade_id ?? null, trade.trade_id, "source_trade_id del lote purchase");

      // Consumo FIFO del vendedor: el lote production perdió exactamente buyQty reservado.
      const aliceLots = await lotsOf(alice, germProduct.product_id);
      const aLot = aliceLots.find((l) => l.origin === "production");
      assert(aLot !== undefined, "lote production del vendedor");
      assertEqual(aLot.qty_reserved_cent, remainingQty, "reserva restante del lote del vendedor (FIFO)");
      assertEqual(aLot.qty_available_cent, 0, "lote del vendedor sin disponible mientras la sell vive");
      const aPos = await positionOf(alice, germProduct.product_id);
      assertEqual(aPos.qty_reserved_cent, remainingQty, "posición reservada del vendedor tras el fill");

      // El endpoint de trades por orden coincide.
      const orderTrades = expectStatus<Trade[]>(
        await api.get(`/orders/${o.order_id}/trades`, { token: bob.accessToken }),
        200,
        "GET /orders/{buy}/trades",
      );
      assertEqual(orderTrades.length, 1, "trades de la orden buy");
      assertEqual(orderTrades[0]?.trade_id, trade.trade_id, "trade_id en /orders/{id}/trades");
      return { buyOrder: o, mainTrade: trade };
    },
  );

  await step("18. ws: order_executed para ambos lados (payload trade + order_id + fill)", async () => {
    const bobNote = await wsBob.waitFor(
      "order_executed de la buy",
      (m) => m.type === "order_executed" && m.payload["order_id"] === buyOrder.order_id,
    );
    assertEqual(bobNote.payload["fill"], "full", "fill del comprador");
    assertEqual(wsTradeId(bobNote.payload), mainTrade.trade_id, "trade_id en payload del comprador");

    const aliceNote = await wsAlice.waitFor(
      "order_executed de la sell",
      (m) => m.type === "order_executed" && m.payload["order_id"] === sellOrder.order_id,
    );
    assertEqual(aliceNote.payload["fill"], "partial", "fill del vendedor");
    assertEqual(wsTradeId(aliceNote.payload), mainTrade.trade_id, "trade_id en payload del vendedor");
  });

  // ---- 19-20. Cancelaciones liberan reservas --------------------------------

  await step("19. órdenes: cancelar sell libera inventario; segundo DELETE es idempotente (200)", async () => {
    await cancelOrder(alice, sellOrder.order_id, "DELETE /orders/{sell}");
    const pos = await positionOf(alice, germProduct.product_id);
    assertEqual(pos.qty_available_cent, remainingQty, "inventario disponible tras cancelar");
    assertEqual(pos.qty_reserved_cent, 0, "reserva de inventario liberada");
    const lots = await lotsOf(alice, germProduct.product_id);
    const prodLot = lots.find((l) => l.origin === "production");
    assert(prodLot !== undefined, "lote production");
    assertEqual(prodLot.qty_reserved_cent, 0, "lote sin reserva tras cancelar");
    assertEqual(prodLot.qty_available_cent, remainingQty, "lote disponible tras cancelar");

    await wsAlice.waitFor(
      "order_cancelled de la sell",
      (m) => m.type === "order_cancelled" && m.payload["order_id"] === sellOrder.order_id,
    );

    // Idempotencia del DELETE sobre orden terminal: 200 con la orden actual.
    const again = await api.delete<Order>(`/orders/${sellOrder.order_id}`, { token: alice.accessToken });
    const body = expectStatus<Order>(again, 200, "DELETE /orders/{sell} repetido");
    assertEqual(body.status, "cancelled", "status terminal sin cambios");
    assertEqual(body.qty_pending_cent, remainingQty, "qty_pending intacta en el DELETE repetido");
  });

  await step("20. órdenes: cancelar buy libera capital reservado (BOB)", async () => {
    const qty = 100;
    const limit = 300;
    const expectedReserve = notionalCents(qty, limit);
    const before = await me(bob);
    const o = await placeOrder(
      bob,
      {
        product_id: germProduct.product_id,
        side: "buy",
        qty_cent: qty,
        limit_price_cents: limit,
        ttl_seconds: MAIN_TTL_SIM_S,
      },
      "POST /orders (buy para cancelar)",
    );
    assertEqual(o.status, "active", "buy activa (no hay asks)");
    const mid = await me(bob);
    assertEqual(mid.capital_reserved_cents, expectedReserve, "reserva = notional(qty, limit) (§5)");
    assertEqual(
      mid.capital_available_cents,
      before.capital_available_cents - expectedReserve,
      "available baja exactamente la reserva",
    );
    await cancelOrder(bob, o.order_id, "DELETE /orders/{buy}");
    const after = await me(bob);
    assertEqual(after.capital_reserved_cents, 0, "reserva liberada al cancelar");
    assertEqual(after.capital_available_cents, before.capital_available_cents, "available restaurado");
  });

  // ---- 21. Expiración TTL ----------------------------------------------------

  await step(
    `21. órdenes: expiración TTL ${EXPIRY_TTL_SIM_S} sim-s (~${Math.round(simSecondsToRealMs(EXPIRY_TTL_SIM_S) / 1000)} s reales + sweep)`,
    async () => {
      const qty = 100;
      const limit = 200;
      const expectedReserve = notionalCents(qty, limit);
      const before = await me(bob);
      const o = await placeOrder(
        bob,
        {
          product_id: germProduct.product_id,
          side: "buy",
          qty_cent: qty,
          limit_price_cents: limit,
          ttl_seconds: EXPIRY_TTL_SIM_S,
        },
        "POST /orders (buy que expira)",
      );
      assertEqual(o.status, "active", "orden activa antes de expirar");
      assertClose(
        Date.parse(o.expires_at),
        Date.parse(o.created_at) + simSecondsToRealMs(EXPIRY_TTL_SIM_S),
        1_500,
        "expires_at del TTL mínimo",
      );
      const mid = await me(bob);
      assertEqual(mid.capital_reserved_cents, expectedReserve, "reserva vigente antes de expirar");

      const expired = await pollUntil(
        `orden ${o.order_id} en status expired (sweep cada ${config.sweeps.orderExpiryIntervalMs} ms)`,
        async () => {
          const r = expectStatus<Order>(
            await api.get(`/orders/${o.order_id}`, { token: bob.accessToken }),
            200,
            "GET /orders/{id}",
          );
          return r.status === "expired" ? r : undefined;
        },
        {
          timeoutMs: simSecondsToRealMs(EXPIRY_TTL_SIM_S) + config.sweeps.orderExpiryIntervalMs + 25_000,
          initialDelayMs: 1_000,
          maxDelayMs: 3_000,
        },
      );
      untrackOrder(o.order_id);
      assertEqual(expired.qty_pending_cent, qty, "qty_pending intacta al expirar");
      const after = await me(bob);
      assertEqual(after.capital_reserved_cents, 0, "reserva liberada al expirar");
      assertEqual(after.capital_available_cents, before.capital_available_cents, "available restaurado al expirar");
      await wsBob.waitFor(
        "order_expired de la buy",
        (m) => m.type === "order_expired" && m.payload["order_id"] === o.order_id,
      );
    },
  );

  // ---- 22. Idempotencia client_order_id --------------------------------------

  await step("22. órdenes: idempotencia por client_order_id (reenvío ⇒ 200 con la misma orden)", async () => {
    const body: PlaceOrderBody = {
      product_id: germProduct.product_id,
      side: "buy",
      qty_cent: 50,
      limit_price_cents: 100,
      ttl_seconds: MAIN_TTL_SIM_S,
      client_order_id: `e2e-idem-${runId}`,
    };
    const first = await placeOrder(bob, body, "POST /orders (idempotente, 1a vez)");
    assertEqual(first.status, "active", "orden idempotente activa");
    const replay = await api.post<PlaceOrderResponse>("/orders", { token: bob.accessToken, body });
    assertEqual(replay.status, 200, "reenvío con mismo client_order_id ⇒ 200, NO 201 (§10.7)");
    const replayed = replay.body;
    assertEqual(replayed.order_id, first.order_id, "misma orden en el reenvío");
    assertEqual((replayed.trades_generated ?? []).length, 0, "sin re-matching en el reenvío");
    await cancelOrder(bob, first.order_id, "DELETE /orders (idempotente)");
  });

  // ---- 22b. Idempotencia CONCURRENTE (reclamo atómico) ------------------------

  await step("22b. órdenes: 2 POST simultáneos con el mismo client_order_id ⇒ exactamente 1 orden", async () => {
    // El reclamo atómico (SET NX) debe dejar pasar exactamente UN 201; el otro
    // POST responde 200 (replay con la misma orden) o 409 conflict_state (si el
    // original seguía en vuelo al llegar el duplicado). qty/limit distintivos
    // (60q @ 110c) para poder verificar unicidad vía GET /orders sin ambigüedad
    // con órdenes de pasos anteriores. Sin llamadas /auth/*: no afecta el
    // presupuesto local de auth.
    const CONC_QTY = 60;
    const CONC_LIMIT = 110;
    const body: PlaceOrderBody = {
      product_id: germProduct.product_id,
      side: "buy",
      qty_cent: CONC_QTY,
      limit_price_cents: CONC_LIMIT,
      ttl_seconds: MAIN_TTL_SIM_S,
      client_order_id: `e2e-idem-conc-${runId}`,
    };
    const [r1, r2] = await Promise.all([
      api.post<PlaceOrderResponse>("/orders", { token: bob.accessToken, body }),
      api.post<PlaceOrderResponse>("/orders", { token: bob.accessToken, body }),
    ]);

    const created = [r1, r2].filter((r) => r.status === 201);
    assertEqual(
      created.length,
      1,
      `exactamente un 201 entre los dos POST concurrentes (status recibidos: ${r1.status} y ${r2.status})`,
    );
    const winner = created[0];
    assert(winner !== undefined, "respuesta 201 presente");
    const winnerOrder = winner.body;
    trackOrder(winnerOrder.order_id, bob);
    assertEqual(winnerOrder.status, "active", "orden ganadora activa (sin asks en el libro)");

    const loser = r1.status === 201 ? r2 : r1;
    assertOneOf(loser.status, [200, 409] as const, "el POST perdedor responde 200 (replay) o 409 (conflict_state)");
    if (loser.status === 200) {
      assertEqual(loser.body.order_id, winnerOrder.order_id, "el replay 200 devuelve la MISMA orden");
      assertEqual((loser.body.trades_generated ?? []).length, 0, "sin re-matching en el replay concurrente");
    } else {
      expectProblem(loser, 409, "POST /orders concurrente (perdedor)", { code: "conflict_state" });
    }

    // Unicidad observable: solo UNA orden viva de bob con esos parámetros.
    const open = expectStatus<Page<Order>>(
      await api.get("/orders", {
        token: bob.accessToken,
        query: { product_id: germProduct.product_id, side: "buy", limit: 200 },
      }),
      200,
      "GET /orders (bob, abiertas)",
    );
    const matching = open.items.filter(
      (o) => o.qty_original_cent === CONC_QTY && o.limit_price_cents === CONC_LIMIT,
    );
    assertEqual(matching.length, 1, "exactamente UNA orden viva creada por los dos POST concurrentes");
    assertEqual(matching[0]?.order_id, winnerOrder.order_id, "la orden viva es la del 201");

    await cancelOrder(bob, winnerOrder.order_id, "DELETE /orders (idem concurrente)");
  });

  // ---- 23. Errores Problem+JSON ----------------------------------------------

  await step("23. errores: Problem+JSON (401, insufficient_capital, insufficient_inventory, ttl, not_owner)", async () => {
    // 401 sin token.
    expectProblem(await api.get("/agents/me"), 401, "GET /agents/me sin token");

    // insufficient_capital: notional astronómico.
    expectProblem(
      await api.post("/orders", {
        token: bob.accessToken,
        body: {
          product_id: germProduct.product_id,
          side: "buy",
          qty_cent: 100_000_000,
          limit_price_cents: 100_000,
          ttl_seconds: MAIN_TTL_SIM_S,
        },
      }),
      422,
      "POST /orders sin capital",
      { code: "insufficient_capital" },
    );

    // insufficient_inventory: vender lo que no se tiene.
    expectProblem(
      await api.post("/orders", {
        token: alice.accessToken,
        body: {
          product_id: germProduct.product_id,
          side: "sell",
          qty_cent: 100_000_000,
          limit_price_cents: 100,
          ttl_seconds: MAIN_TTL_SIM_S,
        },
      }),
      422,
      "POST /orders sin inventario",
      { code: "insufficient_inventory" },
    );

    // TTL fuera de rango: el openapi fija minimum 60 en el schema, así que una
    // implementación conforme puede rechazar con 400 (validación de schema) o
    // con 422 ttl_out_of_range (regla de dominio §10.5). Ambas son Problem+JSON.
    const ttlResp = await api.post("/orders", {
      token: alice.accessToken,
      body: {
        product_id: germProduct.product_id,
        side: "sell",
        qty_cent: 10,
        limit_price_cents: 100,
        ttl_seconds: 1,
      },
    });
    assertOneOf(ttlResp.status, [400, 422] as const, "status de TTL inválido");
    if (ttlResp.status === 422) {
      expectProblem(ttlResp, 422, "POST /orders ttl=1 (dominio)", { code: "ttl_out_of_range" });
    } else {
      expectProblem(ttlResp, 400, "POST /orders ttl=1 (schema)");
    }
    console.log(`  (ttl inválido rechazado con ${ttlResp.status})`);

    // not_owner: BOB consulta una orden de ALICE.
    expectProblem(
      await api.get(`/orders/${sellOrder.order_id}`, { token: bob.accessToken }),
      403,
      "GET /orders/{ajena}",
      { code: "not_owner" },
    );

    // 404 con orden inexistente.
    expectProblem(
      await api.get(`/orders/00000000-0000-7000-8000-000000000000`, { token: bob.accessToken }),
      404,
      "GET /orders/{uuid inexistente}",
    );
  });

  // ---- 24. Paginación de history ----------------------------------------------

  await step("24. history: paginación por cursor de /history/events (ALICE)", async () => {
    const page1 = expectStatus<Page<EventItem>>(
      await api.get("/history/events", { token: alice.accessToken, query: { limit: 2 } }),
      200,
      "GET /history/events?limit=2",
    );
    assertEqual(page1.items.length, 2, "página 1 llena (alice tiene ≥ 5 eventos en esta corrida)");
    const cursor1 = page1.next_cursor;
    assert(cursor1 !== null && cursor1 !== undefined, "next_cursor presente con más páginas");
    const [e0, e1] = page1.items;
    assert(e0 !== undefined && e1 !== undefined, "items de la página 1");
    for (const ev of page1.items) {
      assert(typeof ev.event_id === "string" && ev.event_id.length > 0, "event_id presente");
      assert(typeof ev.event_type === "string", "event_type presente");
      assert(!Number.isNaN(Date.parse(ev.occurred_at)), "occurred_at ISO");
      assert(typeof ev.payload === "object" && ev.payload !== null, "payload objeto");
    }
    assert(e0.event_id > e1.event_id, "orden DESC por event_id (uuidv7, más reciente primero — §17)");

    const page2 = expectStatus<Page<EventItem>>(
      await api.get("/history/events", {
        token: alice.accessToken,
        query: { limit: 2, cursor: cursor1 },
      }),
      200,
      "GET /history/events página 2",
    );
    assert(page2.items.length >= 1, "página 2 no vacía");
    const seen = new Set(page1.items.map((e) => e.event_id));
    for (const ev of page2.items) {
      assert(!seen.has(ev.event_id), `evento ${ev.event_id} repetido entre páginas`);
      assert(ev.event_id < e1.event_id, "página 2 estrictamente anterior al cursor (pk < cursor)");
    }
  });

  // ---- 25. History de trades + conservación de dinero ---------------------------

  await step("25. history: /history/trades refleja el trade con sus fees", async () => {
    const tradesBob = await allHistoryTrades(bob);
    assertEqual(tradesBob.length, 1, "bob participó en exactamente 1 trade en esta corrida");
    const t = tradesBob[0];
    assert(t !== undefined, "trade de bob");
    assertEqual(t.trade_id, mainTrade.trade_id, "trade_id en history");
    assertEqual(t.fee_buyer_cents, tradeExp.feePerSideCents, "fee_buyer en history");
    assertEqual(t.fee_seller_cents, tradeExp.feePerSideCents, "fee_seller en history");
    assertEqual(t.qty_executed_cent, buyQty, "qty en history");
    assertEqual(t.price_cents, SELL_LIMIT_CENTS, "precio en history");

    // Filtro side=buyer: alice nunca compró.
    const aliceAsBuyer = expectStatus<Page<Trade>>(
      await api.get("/history/trades", { token: alice.accessToken, query: { side: "buyer", limit: 200 } }),
      200,
      "GET /history/trades?side=buyer (alice)",
    );
    assertEqual(aliceAsBuyer.items.length, 0, "alice sin trades como buyer");
  });

  await step("26. conservación de dinero: Σ capital + Σ fees + Σ salarios == Σ capital semilla", async () => {
    const [tradesA, tradesB, procsA, procsB, snapA, snapB] = await Promise.all([
      allHistoryTrades(alice),
      allHistoryTrades(bob),
      allProcesses(alice),
      allProcesses(bob),
      me(alice),
      me(bob),
    ]);

    const ourIds = new Set([alice.agentId, bob.agentId]);
    const uniqueTrades = new Map<string, Trade>();
    for (const t of [...tradesA, ...tradesB]) uniqueTrades.set(t.trade_id, t);
    assertEqual(uniqueTrades.size, 1, "los agentes de la suite generaron exactamente 1 trade");
    for (const t of uniqueTrades.values()) {
      assert(
        ourIds.has(t.buyer_agent_id) && ourIds.has(t.seller_agent_id),
        `trade ${t.trade_id} con contraparte externa (${t.buyer_agent_id}/${t.seller_agent_id}); ` +
          "la conservación solo es cerrada entre agentes de la suite",
      );
    }
    const feesCents = [...uniqueTrades.values()].reduce(
      (acc, t) => acc + t.fee_buyer_cents + t.fee_seller_cents,
      0,
    );
    const wagesCents = [...procsA, ...procsB].reduce((acc, p) => acc + p.wage_paid_cents, 0);
    const finalCents = totalCapital(snapA) + totalCapital(snapB);
    const seedCents = alice.seedCapitalCents + bob.seedCapitalCents;
    console.log(
      `  seed=${seedCents}c, final=${finalCents}c, fees=${feesCents}c, salarios=${wagesCents}c ` +
        `(final+fees+salarios=${finalCents + feesCents + wagesCents}c)`,
    );
    assertEqual(
      finalCents + feesCents + wagesCents,
      seedCents,
      "conservación de dinero (§5): capital final + fees + salarios = capital semilla",
    );
  });

  await finishAndExit(0);
}

await main();
