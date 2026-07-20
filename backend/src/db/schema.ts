/**
 * Espejo Drizzle EXACTO de specs/schema.sql (v1).
 *
 * IMPORTANTE: el DDL real lo aplica Postgres al inicializar el contenedor
 * (docker-entrypoint-initdb.d monta specs/schema.sql). drizzle-kit NO genera
 * migraciones en v1; este archivo existe para tipado y query building.
 * Ante cualquier discrepancia, specs/schema.sql manda (contrato §7).
 *
 * Convenciones:
 *   - Nombres de columna snake_case idénticos al DDL; exports en camelCase.
 *   - BIGINT con { mode: "number" } (contrato §1).
 *   - UUID v7 nativo de Postgres 18: .default(sql`uuidv7()`).
 *   - TIMESTAMPTZ = timestamp({ withTimezone: true }).
 *   - Los CHECKs llevan los nombres que Postgres auto-genera para los
 *     constraints anónimos del DDL ({tabla}_{columna}_check / {tabla}_check,
 *     {tabla}_check1, ...). Son informativos: el DDL real los aplica.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  interval,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// =============================================================================
// TIPOS ENUM
// =============================================================================

export const productCategory = pgEnum("product_category", [
  "raw_primary",
  "intermediate",
  "final_consumption",
]);

export const agentRole = pgEnum("agent_role", [
  "primary_producer",
  "transformer",
  "consumer",
  "trader",
  // Rol de solo-monitoreo (panel admin): no participa en el mercado y no es
  // registrable por /auth/register. Ver MARKET_ROLES en types/contracts.ts.
  "admin",
  // Banco central del patrón oro: agente único del seed, sin credenciales,
  // no registrable. Opera la ventanilla de convertibilidad y recibe fees.
  // Excluido de agregados de mercado (NON_MARKET_ROLES en types/contracts.ts).
  "bank",
  // Ciudad-consumidor: demanda final urbana. Se SIEMBRA (con credenciales, para
  // login de bots) y NO es registrable por humanos. SÍ participa del mercado
  // (SEEDABLE_MARKET_ROLES en types/contracts.ts). Recibe ingreso recurrente del
  // flujo circular (salarios reciclados + tasa de consumo) vía city_income.
  "city",
]);

export const agentStatus = pgEnum("agent_status", ["active", "bankrupt"]);

export const orderSide = pgEnum("order_side", ["buy", "sell"]);

export const orderStatus = pgEnum("order_status", [
  "active",
  "partial",
  "completed",
  "cancelled",
  "expired",
]);

export const processStatus = pgEnum("process_status", [
  "running",
  "completed",
  "cancelled",
]);

export const inventoryLotOrigin = pgEnum("inventory_lot_origin", [
  "initial", // carga inicial del setup
  "production", // producido por transformación
  "purchase", // adquirido vía trade
  "conversion", // adquirido vía ventanilla del banco (gold_conversion)
]);

export const eventType = pgEnum("event_type", [
  "agent_registered",
  "agent_bankrupt",
  "order_placed",
  "order_cancelled",
  "order_expired",
  "trade_executed",
  "process_started",
  "process_completed",
  "process_cancelled",
  "snapshot_taken",
  "gold_converted", // conversión ejecutada en la ventanilla del banco
  "money_issued", // acuñación de capital semilla en un registro dinámico
  "deposit_depleted", // un resource_deposit llegó a 0 (yacimiento agotado)
  "city_income_distributed", // el sweeper repartió el income_ledger entre ciudades
]);

// Dirección de una conversión de ventanilla, desde la perspectiva del agente:
// buy_gold = compra oro al banco (paga window_ask, el dinero se DESTRUYE);
// sell_gold = vende oro al banco (cobra window_bid, el dinero se ACUÑA).
export const conversionDirection = pgEnum("conversion_direction", [
  "buy_gold",
  "sell_gold",
]);

// =============================================================================
// 1. CATÁLOGO
// =============================================================================

export const product = pgTable("product", {
  productId: uuid("product_id").primaryKey().default(sql`uuidv7()`),
  // Identificador estable del catálogo (seed-config `key`, ej. 'trigo').
  key: text("key").notNull().unique(),
  name: text("name").notNull().unique(),
  unit: text("unit").notNull(),
  category: productCategory("category").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const recipe = pgTable(
  "recipe",
  {
    recipeId: uuid("recipe_id").primaryKey().default(sql`uuidv7()`),
    outputProductId: uuid("output_product_id")
      .notNull()
      .references(() => product.productId),
    outputQty: bigint("output_qty", { mode: "number" }).notNull(),
    // INTERVAL en tiempo SIMULADO (contrato §4): segundos simulados de una
    // ejecución = épocas del interval.
    duration: interval("duration").notNull(),
    wageRateCentsPerSec: bigint("wage_rate_cents_per_sec", {
      mode: "number",
    }).notNull(),
    // Salario total de una ejecución = wage_rate_cents_per_sec * EXTRACT(EPOCH FROM duration).
    // Se calcula en aplicación al iniciar el proceso para evitar drift por
    // cambios futuros del rate.
    name: text("name").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("recipe_output_qty_check", sql`${t.outputQty} > 0`),
    check("recipe_duration_check", sql`${t.duration} > INTERVAL '0'`),
    check(
      "recipe_wage_rate_cents_per_sec_check",
      sql`${t.wageRateCentsPerSec} >= 0`,
    ),
  ],
);

export const recipeInput = pgTable(
  "recipe_input",
  {
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipe.recipeId, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.productId),
    qtyRequired: bigint("qty_required", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.recipeId, t.productId] }),
    check("recipe_input_qty_required_check", sql`${t.qtyRequired} > 0`),
  ],
);

// =============================================================================
// 2. AGENTES, AUTENTICACIÓN Y CAPACIDADES
// =============================================================================

export const agent = pgTable(
  "agent",
  {
    agentId: uuid("agent_id").primaryKey().default(sql`uuidv7()`),
    username: text("username").notNull().unique(),
    role: agentRole("role").notNull(),
    status: agentStatus("status").notNull().default("active"),
    capitalAvailable: bigint("capital_available", { mode: "number" })
      .notNull()
      .default(0),
    capitalReserved: bigint("capital_reserved", { mode: "number" })
      .notNull()
      .default(0),
    seedCapital: bigint("seed_capital", { mode: "number" }).notNull(),
    // Peso de población: SOLO lo usan las ciudades (rol `city`). Escala su
    // capital semilla y su parte del reparto de ingreso recurrente. NULL para
    // el resto de roles.
    populationWeight: bigint("population_weight", { mode: "number" }),
    registeredAt: timestamp("registered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    bankruptAt: timestamp("bankrupt_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_agent_status_active")
      .on(t.status)
      .where(sql`${t.status} = 'active'`),
    check("agent_capital_available_check", sql`${t.capitalAvailable} >= 0`),
    check("agent_capital_reserved_check", sql`${t.capitalReserved} >= 0`),
  ],
);

// Credenciales separadas del agente para mantener el hash fuera de queries
// de dominio normales y permitir rotación sin tocar la tabla principal.
export const agentCredentials = pgTable("agent_credentials", {
  agentId: uuid("agent_id")
    .primaryKey()
    .references(() => agent.agentId, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(), // argon2id (Bun.password)
  passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// JWT refresh tokens activos. Los access tokens son stateless; los refresh
// se persisten para poder revocarlos (quiebra, cambio de contraseña).
export const agentRefreshToken = pgTable(
  "agent_refresh_token",
  {
    tokenId: uuid("token_id").primaryKey().default(sql`uuidv7()`),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agent.agentId, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(), // nunca guardar el token en claro
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_refresh_token_agent")
      .on(t.agentId)
      .where(sql`${t.revokedAt} IS NULL`),
    index("idx_refresh_token_hash")
      .on(t.tokenHash)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

export const agentCapacity = pgTable(
  "agent_capacity",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agent.agentId),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipe.recipeId),
    installations: integer("installations").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.recipeId] }),
    check("agent_capacity_installations_check", sql`${t.installations} > 0`),
  ],
);

// =============================================================================
// 3. ÓRDENES Y TRANSACCIONES
// =============================================================================

export const marketOrder = pgTable(
  "market_order",
  {
    orderId: uuid("order_id").primaryKey().default(sql`uuidv7()`),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agent.agentId),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.productId),
    side: orderSide("side").notNull(),
    qtyOriginal: bigint("qty_original", { mode: "number" }).notNull(),
    qtyPending: bigint("qty_pending", { mode: "number" }).notNull(),
    limitPriceCents: bigint("limit_price_cents", { mode: "number" }).notNull(),
    status: orderStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("idx_orderbook_buy")
      .on(t.productId, t.limitPriceCents.desc(), t.createdAt.asc())
      .where(sql`${t.status} IN ('active', 'partial') AND ${t.side} = 'buy'`),
    index("idx_orderbook_sell")
      .on(t.productId, t.limitPriceCents.asc(), t.createdAt.asc())
      .where(sql`${t.status} IN ('active', 'partial') AND ${t.side} = 'sell'`),
    index("idx_order_agent_active")
      .on(t.agentId)
      .where(sql`${t.status} IN ('active', 'partial')`),
    index("idx_order_expiring")
      .on(t.expiresAt)
      .where(sql`${t.status} IN ('active', 'partial')`),
    check("market_order_qty_original_check", sql`${t.qtyOriginal} > 0`),
    check("market_order_qty_pending_check", sql`${t.qtyPending} >= 0`),
    check(
      "market_order_limit_price_cents_check",
      sql`${t.limitPriceCents} > 0`,
    ),
    check("market_order_check", sql`${t.qtyPending} <= ${t.qtyOriginal}`),
    check("market_order_check1", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

export const trade = pgTable(
  "trade",
  {
    tradeId: uuid("trade_id").primaryKey().default(sql`uuidv7()`),
    buyOrderId: uuid("buy_order_id")
      .notNull()
      .references(() => marketOrder.orderId),
    sellOrderId: uuid("sell_order_id")
      .notNull()
      .references(() => marketOrder.orderId),
    buyerAgentId: uuid("buyer_agent_id")
      .notNull()
      .references(() => agent.agentId),
    sellerAgentId: uuid("seller_agent_id")
      .notNull()
      .references(() => agent.agentId),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.productId),
    qtyExecuted: bigint("qty_executed", { mode: "number" }).notNull(),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(),
    feeBuyerCents: bigint("fee_buyer_cents", { mode: "number" }).notNull(),
    feeSellerCents: bigint("fee_seller_cents", { mode: "number" }).notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_trade_product_time").on(t.productId, t.executedAt.desc()),
    index("idx_trade_buyer").on(t.buyerAgentId, t.executedAt.desc()),
    index("idx_trade_seller").on(t.sellerAgentId, t.executedAt.desc()),
    index("idx_trade_buy_order").on(t.buyOrderId),
    index("idx_trade_sell_order").on(t.sellOrderId),
    check("trade_qty_executed_check", sql`${t.qtyExecuted} > 0`),
    check("trade_price_cents_check", sql`${t.priceCents} > 0`),
    check("trade_fee_buyer_cents_check", sql`${t.feeBuyerCents} >= 0`),
    check("trade_fee_seller_cents_check", sql`${t.feeSellerCents} >= 0`),
  ],
);

// Conversión ejecutada en la ventanilla del banco central (patrón oro).
// Sin fees; price_cents_per_unit es el bid/ask de gold_standard según la
// dirección. Declarada antes de inventory_lot por la FK source_conversion_id.
export const goldConversion = pgTable(
  "gold_conversion",
  {
    conversionId: uuid("conversion_id").primaryKey().default(sql`uuidv7()`),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agent.agentId),
    direction: conversionDirection("direction").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.productId),
    qtyCent: bigint("qty_cent", { mode: "number" }).notNull(),
    priceCentsPerUnit: bigint("price_cents_per_unit", {
      mode: "number",
    }).notNull(),
    totalCents: bigint("total_cents", { mode: "number" }).notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_gold_conversion_agent_time").on(t.agentId, t.executedAt.desc()),
    check("gold_conversion_qty_cent_check", sql`${t.qtyCent} > 0`),
    check(
      "gold_conversion_price_cents_per_unit_check",
      sql`${t.priceCentsPerUnit} > 0`,
    ),
    check("gold_conversion_total_cents_check", sql`${t.totalCents} >= 0`),
  ],
);

// =============================================================================
// 4. PROCESOS DE TRANSFORMACIÓN
// =============================================================================

export const transformationProcess = pgTable(
  "transformation_process",
  {
    processId: uuid("process_id").primaryKey().default(sql`uuidv7()`),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agent.agentId),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipe.recipeId),
    executionsPlanned: integer("executions_planned").notNull(),
    // NO se persiste el avance en vivo (contrato §10.9): queda en 1 mientras
    // corre; la lectura calcula la ejecución actual con tiempo simulado y al
    // completar se persiste = executions_planned.
    currentExecution: integer("current_execution").notNull().default(1),
    status: processStatus("status").notNull().default("running"),
    wagePaidCents: bigint("wage_paid_cents", { mode: "number" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expectedEndAt: timestamp("expected_end_at", {
      withTimezone: true,
    }).notNull(),
    actualEndAt: timestamp("actual_end_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_process_running_expired")
      .on(t.expectedEndAt)
      .where(sql`${t.status} = 'running'`),
    index("idx_process_agent_running")
      .on(t.agentId)
      .where(sql`${t.status} = 'running'`),
    check(
      "transformation_process_executions_planned_check",
      sql`${t.executionsPlanned} > 0`,
    ),
    check(
      "transformation_process_wage_paid_cents_check",
      sql`${t.wagePaidCents} >= 0`,
    ),
    check(
      "transformation_process_check",
      sql`${t.currentExecution} <= ${t.executionsPlanned}`,
    ),
    check(
      "transformation_process_check1",
      sql`${t.expectedEndAt} > ${t.startedAt}`,
    ),
  ],
);

// =============================================================================
// 5. INVENTARIO POR LOTES (FIFO)
// =============================================================================
//
// Cada adquisición o producción genera un lote con su precio unitario de
// adquisición. Consumo FIFO: SIEMPRE ordenado por (acquired_at ASC, lot_id ASC).

export const inventoryLot = pgTable(
  "inventory_lot",
  {
    lotId: uuid("lot_id").primaryKey().default(sql`uuidv7()`),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agent.agentId),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.productId),
    origin: inventoryLotOrigin("origin").notNull(),
    qtyOriginal: bigint("qty_original", { mode: "number" }).notNull(),
    qtyAvailable: bigint("qty_available", { mode: "number" }).notNull(),
    qtyReserved: bigint("qty_reserved", { mode: "number" })
      .notNull()
      .default(0),
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sourceTradeId: uuid("source_trade_id").references(() => trade.tradeId),
    sourceProcessId: uuid("source_process_id").references(
      () => transformationProcess.processId,
    ),
    sourceConversionId: uuid("source_conversion_id").references(
      () => goldConversion.conversionId,
    ),
  },
  (t) => [
    // Índice clave para consumo FIFO. UUIDv7 desempata por tiempo de creación
    // si dos lotes tienen el mismo acquired_at.
    index("idx_lot_fifo")
      .on(t.agentId, t.productId, t.acquiredAt, t.lotId)
      .where(sql`${t.qtyAvailable} > 0 OR ${t.qtyReserved} > 0`),
    index("idx_lot_source_trade")
      .on(t.sourceTradeId)
      .where(sql`${t.sourceTradeId} IS NOT NULL`),
    index("idx_lot_source_process")
      .on(t.sourceProcessId)
      .where(sql`${t.sourceProcessId} IS NOT NULL`),
    index("idx_lot_source_conversion")
      .on(t.sourceConversionId)
      .where(sql`${t.sourceConversionId} IS NOT NULL`),
    check("inventory_lot_qty_original_check", sql`${t.qtyOriginal} > 0`),
    check("inventory_lot_qty_available_check", sql`${t.qtyAvailable} >= 0`),
    check("inventory_lot_qty_reserved_check", sql`${t.qtyReserved} >= 0`),
    check(
      "inventory_lot_unit_cost_cents_check",
      sql`${t.unitCostCents} >= 0`,
    ),
    check(
      "inventory_lot_check",
      sql`${t.qtyAvailable} + ${t.qtyReserved} <= ${t.qtyOriginal}`,
    ),
    check(
      "inventory_lot_check1",
      sql`(${t.origin} = 'purchase' AND ${t.sourceTradeId} IS NOT NULL AND ${t.sourceProcessId} IS NULL AND ${t.sourceConversionId} IS NULL) OR (${t.origin} = 'production' AND ${t.sourceProcessId} IS NOT NULL AND ${t.sourceTradeId} IS NULL AND ${t.sourceConversionId} IS NULL) OR (${t.origin} = 'conversion' AND ${t.sourceConversionId} IS NOT NULL AND ${t.sourceTradeId} IS NULL AND ${t.sourceProcessId} IS NULL) OR (${t.origin} = 'initial' AND ${t.sourceTradeId} IS NULL AND ${t.sourceProcessId} IS NULL AND ${t.sourceConversionId} IS NULL)`,
    ),
  ],
);

// =============================================================================
// 6. TRAZABILIDAD DE CONSUMO DE LOTES
// =============================================================================

// Trazabilidad lote → trade en ventas (COGS por trade).
export const tradeLotConsumption = pgTable(
  "trade_lot_consumption",
  {
    tradeId: uuid("trade_id")
      .notNull()
      .references(() => trade.tradeId, { onDelete: "cascade" }),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => inventoryLot.lotId),
    qtyConsumed: bigint("qty_consumed", { mode: "number" }).notNull(),
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(), // snapshot del costo
  },
  (t) => [
    primaryKey({ columns: [t.tradeId, t.lotId] }),
    check(
      "trade_lot_consumption_qty_consumed_check",
      sql`${t.qtyConsumed} > 0`,
    ),
    check(
      "trade_lot_consumption_unit_cost_cents_check",
      sql`${t.unitCostCents} >= 0`,
    ),
  ],
);

// Insumos consumidos al iniciar un proceso, trazables a lotes específicos.
export const transformationLotConsumption = pgTable(
  "transformation_lot_consumption",
  {
    processId: uuid("process_id")
      .notNull()
      .references(() => transformationProcess.processId, {
        onDelete: "cascade",
      }),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => inventoryLot.lotId),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.productId),
    qtyConsumed: bigint("qty_consumed", { mode: "number" }).notNull(),
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.processId, t.lotId] }),
    check(
      "transformation_lot_consumption_qty_consumed_check",
      sql`${t.qtyConsumed} > 0`,
    ),
    check(
      "transformation_lot_consumption_unit_cost_cents_check",
      sql`${t.unitCostCents} >= 0`,
    ),
  ],
);

// Lotes consumidos por una conversión de ventanilla (FIFO del lado que
// entrega el oro). Espejo de trade_lot_consumption para COGS/auditoría.
export const conversionLotConsumption = pgTable(
  "conversion_lot_consumption",
  {
    conversionId: uuid("conversion_id")
      .notNull()
      .references(() => goldConversion.conversionId, { onDelete: "cascade" }),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => inventoryLot.lotId),
    qtyConsumed: bigint("qty_consumed", { mode: "number" }).notNull(),
    unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conversionId, t.lotId] }),
    check(
      "conversion_lot_consumption_qty_consumed_check",
      sql`${t.qtyConsumed} > 0`,
    ),
    check(
      "conversion_lot_consumption_unit_cost_cents_check",
      sql`${t.unitCostCents} >= 0`,
    ),
  ],
);

// Ledger append-only de fees de matching acreditados al banco central (ADR-019).
// El hot path INSERTA un registro por orden que genera fees; un sweeper del
// Worker los pliega al capital del banco (materialized). Saldo del banco =
// agent.capital_available + SUM(amount_cents) WHERE NOT materialized.
export const feeLedger = pgTable(
  "fee_ledger",
  {
    feeId: uuid("fee_id").primaryKey().default(sql`uuidv7()`),
    tradeId: uuid("trade_id")
      .notNull()
      .references(() => trade.tradeId, { onDelete: "cascade" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    materialized: boolean("materialized").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("fee_ledger_amount_cents_check", sql`${t.amountCents} > 0`),
    index("idx_fee_ledger_pending").on(t.feeId).where(sql`NOT ${t.materialized}`),
  ],
);

// Origen de una fila de income_ledger: 'wage' = salario reciclado (antes se
// destruía) de un proceso; 'tax' = fracción del fee de un trade (tasa de
// consumo). Ver flujo circular en docs/patron_oro_sistema_bancario.md.
export const incomeSource = pgEnum("income_source", ["wage", "tax"]);

// Ledger append-only del ingreso recurrente de las ciudades (flujo circular,
// gemelo de fee_ledger — ADR-019). El hot path INSERTA: el pago de salario
// (transformation-service) y el split del fee (order-service). Un sweeper del
// Worker (city-income-sweeper) pliega lo pendiente y lo reparte entre las
// ciudades activas ponderado por population_weight. Dinero en tránsito (aún no
// repartido) = SUM(amount_cents) WHERE NOT materialized; cuenta en la
// conservación monetaria.
export const incomeLedger = pgTable(
  "income_ledger",
  {
    incomeId: uuid("income_id").primaryKey().default(sql`uuidv7()`),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    source: incomeSource("source").notNull(),
    // Trazabilidad del origen (uno u otro según source). ON DELETE CASCADE
    // como fee_ledger; procesos y trades no se borran en la práctica.
    sourceProcessId: uuid("source_process_id").references(
      () => transformationProcess.processId,
      { onDelete: "cascade" },
    ),
    sourceTradeId: uuid("source_trade_id").references(() => trade.tradeId, {
      onDelete: "cascade",
    }),
    materialized: boolean("materialized").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("income_ledger_amount_cents_check", sql`${t.amountCents} > 0`),
    index("idx_income_ledger_pending")
      .on(t.incomeId)
      .where(sql`NOT ${t.materialized}`),
  ],
);

// =============================================================================
// 7. EVENT LOG (append-only, sin particionado en v1)
// =============================================================================

export const eventLog = pgTable(
  "event_log",
  {
    eventId: uuid("event_id").primaryKey().default(sql`uuidv7()`),
    eventType: eventType("event_type").notNull(),
    agentId: uuid("agent_id").references(() => agent.agentId), // nullable: eventos del sistema
    payload: jsonb("payload").notNull(), // esquema libre por event_type
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_event_log_agent_time")
      .on(t.agentId, t.occurredAt.desc())
      .where(sql`${t.agentId} IS NOT NULL`),
    index("idx_event_log_type_time").on(t.eventType, t.occurredAt.desc()),
    index("idx_event_log_time").on(t.occurredAt.desc()),
  ],
);

// =============================================================================
// 8. SNAPSHOTS AGREGADOS (disparados manualmente)
// =============================================================================

export const marketSnapshot = pgTable(
  "market_snapshot",
  {
    snapshotId: uuid("snapshot_id").primaryKey().default(sql`uuidv7()`),
    takenAt: timestamp("taken_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    activeAgents: integer("active_agents").notNull(),
    totalMoneyCents: bigint("total_money_cents", { mode: "number" }).notNull(),
    feesCollectedCents: bigint("fees_collected_cents", {
      mode: "number",
    }).notNull(),
    // Patrón oro: estado del banco y del yacimiento (NULL si no hay
    // gold_standard sembrado en la corrida).
    bankMoneyCents: bigint("bank_money_cents", { mode: "number" }),
    bankGoldQtyCent: bigint("bank_gold_qty_cent", { mode: "number" }),
    depositRemainingCent: bigint("deposit_remaining_cent", { mode: "number" }),
    moneyIssuedCents: bigint("money_issued_cents", { mode: "number" }),
    moneyBurnedCents: bigint("money_burned_cents", { mode: "number" }),
    wagesPaidCents: bigint("wages_paid_cents", { mode: "number" }),
    // Invariante de conservación (debe ser 0): Σ capital de TODOS los agentes
    // + wages_paid − initial_money − money_issued + money_burned.
    conservationDeltaCents: bigint("conservation_delta_cents", {
      mode: "number",
    }),
    note: text("note"), // por qué se disparó este snapshot
  },
  (t) => [unique("market_snapshot_taken_at_key").on(t.takenAt)],
);

export const marketSnapshotAgentCapital = pgTable(
  "market_snapshot_agent_capital",
  {
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => marketSnapshot.snapshotId, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agent.agentId),
    capitalTotal: bigint("capital_total", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.agentId] })],
);

export const marketSnapshotProduct = pgTable(
  "market_snapshot_product",
  {
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => marketSnapshot.snapshotId, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.productId),
    totalInventory: bigint("total_inventory", { mode: "number" }).notNull(),
    bestBidCents: bigint("best_bid_cents", { mode: "number" }),
    bestAskCents: bigint("best_ask_cents", { mode: "number" }),
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.productId] })],
);

// =============================================================================
// 9. PATRÓN ORO: YACIMIENTO FINITO Y BANCO CENTRAL
// =============================================================================

// Stock global FINITO de un recurso primario; sorteado en el seed y agotado
// por la producción (clamp en materializeProcess). Genérico por product_id;
// en v1 solo se siembra para el oro.
export const resourceDeposit = pgTable(
  "resource_deposit",
  {
    productId: uuid("product_id")
      .primaryKey()
      .references(() => product.productId),
    qtyInitialCent: bigint("qty_initial_cent", { mode: "number" }).notNull(),
    qtyRemainingCent: bigint("qty_remaining_cent", {
      mode: "number",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("resource_deposit_qty_initial_cent_check", sql`${t.qtyInitialCent} >= 0`),
    check(
      "resource_deposit_qty_remaining_cent_check",
      sql`${t.qtyRemainingCent} >= 0`,
    ),
    check(
      "resource_deposit_check",
      sql`${t.qtyRemainingCent} <= ${t.qtyInitialCent}`,
    ),
  ],
);

// Singleton con la política monetaria de la corrida (escrita por el seed;
// solo mutan los contadores issued/burned). Su fila FOR UPDATE es el mutex
// de ventanilla + emisión de registro; el matching nunca la toca.
export const goldStandard = pgTable(
  "gold_standard",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    bankAgentId: uuid("bank_agent_id")
      .notNull()
      .references(() => agent.agentId),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.productId),
    parityCentsPerUnit: bigint("parity_cents_per_unit", {
      mode: "number",
    }).notNull(),
    windowBidCents: bigint("window_bid_cents", { mode: "number" }).notNull(),
    windowAskCents: bigint("window_ask_cents", { mode: "number" }).notNull(),
    coverageRatioBps: bigint("coverage_ratio_bps", { mode: "number" }).notNull(),
    initialMoneyCents: bigint("initial_money_cents", {
      mode: "number",
    }).notNull(),
    moneyIssuedCents: bigint("money_issued_cents", { mode: "number" })
      .notNull()
      .default(0),
    moneyBurnedCents: bigint("money_burned_cents", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("gold_standard_singleton_check", sql`${t.singleton}`),
    check(
      "gold_standard_parity_cents_per_unit_check",
      sql`${t.parityCentsPerUnit} > 0`,
    ),
    check("gold_standard_window_bid_cents_check", sql`${t.windowBidCents} > 0`),
    check(
      "gold_standard_coverage_ratio_bps_check",
      sql`${t.coverageRatioBps} > 0`,
    ),
    check(
      "gold_standard_initial_money_cents_check",
      sql`${t.initialMoneyCents} >= 0`,
    ),
    check(
      "gold_standard_money_issued_cents_check",
      sql`${t.moneyIssuedCents} >= 0`,
    ),
    check(
      "gold_standard_money_burned_cents_check",
      sql`${t.moneyBurnedCents} >= 0`,
    ),
    check(
      "gold_standard_check",
      sql`${t.windowAskCents} >= ${t.windowBidCents}`,
    ),
  ],
);

// =============================================================================
// Tipos de fila inferidos (conveniencia para repositorios/servicios)
// =============================================================================

export type ProductRow = typeof product.$inferSelect;
export type RecipeRow = typeof recipe.$inferSelect;
export type RecipeInputRow = typeof recipeInput.$inferSelect;
export type AgentRow = typeof agent.$inferSelect;
export type AgentCredentialsRow = typeof agentCredentials.$inferSelect;
export type AgentRefreshTokenRow = typeof agentRefreshToken.$inferSelect;
export type AgentCapacityRow = typeof agentCapacity.$inferSelect;
export type MarketOrderRow = typeof marketOrder.$inferSelect;
export type TradeRow = typeof trade.$inferSelect;
export type FeeLedgerRow = typeof feeLedger.$inferSelect;
export type IncomeLedgerRow = typeof incomeLedger.$inferSelect;
export type TransformationProcessRow =
  typeof transformationProcess.$inferSelect;
export type InventoryLotRow = typeof inventoryLot.$inferSelect;
export type TradeLotConsumptionRow = typeof tradeLotConsumption.$inferSelect;
export type TransformationLotConsumptionRow =
  typeof transformationLotConsumption.$inferSelect;
export type GoldConversionRow = typeof goldConversion.$inferSelect;
export type ConversionLotConsumptionRow =
  typeof conversionLotConsumption.$inferSelect;
export type ResourceDepositRow = typeof resourceDeposit.$inferSelect;
export type GoldStandardRow = typeof goldStandard.$inferSelect;
export type EventLogRow = typeof eventLog.$inferSelect;
export type MarketSnapshotRow = typeof marketSnapshot.$inferSelect;
export type MarketSnapshotAgentCapitalRow =
  typeof marketSnapshotAgentCapital.$inferSelect;
export type MarketSnapshotProductRow = typeof marketSnapshotProduct.$inferSelect;
