-- =============================================================================
-- Modelo de datos: Simulación de mercado agrícola (v1)
-- Motor: PostgreSQL 18+ (requerido para uuidv7() nativo)
-- =============================================================================
--
-- Decisiones de modelado (ratificadas):
--   * Motor: PostgreSQL (estado + log) + Redis (transporte WebSocket).
--   * Tiempo: TIMESTAMPTZ real. Duraciones como INTERVAL.
--     NOTA: pausar o cambiar el factor de simulación mid-run requeriría
--     recalcular expiraciones de órdenes y procesos vivos. Se asume que el
--     factor es fijo durante una corrida.
--   * Cantidades: BIGINT en centésimas. Dinero: BIGINT en centavos.
--   * IDs: UUID v7 (nativo Postgres 18) en todas las tablas; los UUIDv7 son
--     monotónicos por tiempo, así que sirven también como índices ordenados
--     para órdenes, trades, procesos y eventos.
--   * Inventario por lotes: una fila por adquisición/producción. Consumo FIFO.
--   * Trade desnormalizado con identidades de comprador y vendedor.
--   * Sin particionado en v1 (se evaluará cuando crezca el event_log).
--   * Enums nativos.
--   * Auth: usuario/contraseña + JWT. Tabla agent_credentials para hashes.
--   * Snapshots disparados manualmente (no se modela frecuencia).
--   * event_log con event_type ENUM y payload JSONB libre.
--   * Configuración: cargada desde .env al arranque. La corrida es única por
--     instancia y la configuración es estática durante su vida.
-- =============================================================================


-- =============================================================================
-- TIPOS ENUM
-- =============================================================================

CREATE TYPE product_category AS ENUM (
    'raw_primary',
    'intermediate',
    'final_consumption'
);

CREATE TYPE agent_role AS ENUM (
    -- Único rol productivo (ADR-022): extraer y transformar son el mismo acto
    -- económico (toda receta consume algo salvo la extracción de agua), así que
    -- el antiguo 'primary_producer' desapareció y sus tipos de instalación
    -- (campo, mina, pozo_agua, …) pertenecen a 'transformer'.
    'transformer',
    'consumer',
    'trader',
    -- Rol de solo-monitoreo: NO participa en el mercado (sin capital ni
    -- capacidades) y NO es registrable vía POST /auth/register. Se crea con el
    -- bootstrap de admin (bun src/seed-admin.ts). Las agregaciones de mercado
    -- lo excluyen (role <> 'admin').
    'admin',
    -- Banco central del patrón oro: agente ÚNICO creado por el seed, sin
    -- credenciales (no logueable) y NO registrable. No coloca órdenes; opera
    -- la ventanilla de convertibilidad (/bank/convert), recibe los fees de
    -- trading y respalda la emisión de capital semilla con sus reservas de
    -- oro (lotes de inventory_lot). Las agregaciones de mercado lo excluyen
    -- igual que a admin (role NOT IN ('admin','bank')).
    'bank',
    -- Ciudad-consumidor: demanda final urbana. Se SIEMBRA con credenciales
    -- (login de bots-ciudad) y NO es registrable por humanos. A diferencia de
    -- admin/bank, SÍ participa del mercado (SEEDABLE_MARKET_ROLES). Recibe
    -- ingreso recurrente del flujo circular (salarios reciclados + tasa de
    -- consumo) vía el city-income-sweeper.
    'city'
);

CREATE TYPE agent_status AS ENUM (
    'active',
    'bankrupt'
);

CREATE TYPE order_side AS ENUM (
    'buy',
    'sell'
);

CREATE TYPE order_status AS ENUM (
    'active',
    'partial',
    'completed',
    'cancelled',
    'expired'
);

CREATE TYPE process_status AS ENUM (
    'running',
    'completed',
    'cancelled'
);

CREATE TYPE inventory_lot_origin AS ENUM (
    'initial',       -- carga inicial del setup
    'production',    -- producido por transformación
    'purchase',      -- adquirido vía trade
    'conversion'     -- adquirido vía ventanilla del banco (gold_conversion)
);

CREATE TYPE event_type AS ENUM (
    'agent_registered',
    'agent_bankrupt',
    'order_placed',
    'order_cancelled',
    'order_expired',
    'trade_executed',
    'process_started',
    'process_completed',
    'process_cancelled',
    'snapshot_taken',
    'gold_converted',    -- conversión ejecutada en la ventanilla del banco
    'money_issued',      -- acuñación de capital semilla en un registro dinámico
    'deposit_depleted',  -- un resource_deposit llegó a 0 (yacimiento agotado)
    'city_income_distributed', -- el sweeper repartió el income_ledger entre ciudades
    'installation_purchased'   -- un agente compró o mejoró una instalación
);

-- Dirección de una conversión en la ventanilla, desde la perspectiva del
-- agente: buy_gold = el agente compra oro al banco (paga window_ask, el
-- dinero se DESTRUYE); sell_gold = el agente vende oro al banco (cobra
-- window_bid, el dinero se ACUÑA).
CREATE TYPE conversion_direction AS ENUM (
    'buy_gold',
    'sell_gold'
);


-- =============================================================================
-- 1. CATÁLOGO
-- =============================================================================

CREATE TABLE product (
    product_id      UUID                PRIMARY KEY DEFAULT uuidv7(),
    -- Identificador estable del catálogo (seed-config `key`, ej. 'trigo');
    -- permite a los clientes mapear su configuración sin depender del UUID.
    key             TEXT                NOT NULL UNIQUE,
    name            TEXT                NOT NULL UNIQUE,
    unit            TEXT                NOT NULL,
    category        product_category    NOT NULL,
    created_at      TIMESTAMPTZ         NOT NULL DEFAULT now()
);

-- Tipo de instalación: "lugar" productivo que los agentes COMPRAN y SUBEN DE
-- NIVEL para producir (economía de instalaciones, ADR-021). Agrupa varias
-- recetas afines (ej. 'campo' → todos los cultivos; 'metalurgia' → acero/inox/
-- viga/lámina). El nivel de una instalación (nº de hectáreas / líneas de
-- producción) es el presupuesto de concurrencia COMPARTIDO entre las recetas
-- del tipo. Sembrado desde infra/seed-config.json; catálogo estático en la
-- corrida. `role` restringe qué rol puede comprarlo.
CREATE TABLE installation_type (
    installation_type_id UUID          PRIMARY KEY DEFAULT uuidv7(),
    key                  TEXT          NOT NULL UNIQUE,   -- ej. 'campo', 'metalurgia'
    name                 TEXT          NOT NULL UNIQUE,   -- humano, ej. 'Campo agrícola'
    role                 agent_role    NOT NULL,          -- rol que puede comprarlo
    unit_label           TEXT          NOT NULL,          -- 'hectareas' | 'lineas_produccion' | ...
    base_price_cents     BIGINT        NOT NULL CHECK (base_price_cents > 0),  -- precio nivel 0→1
    growth_bps           INT           NOT NULL CHECK (growth_bps > 0),        -- escalado por nivel (10000 = ×1)
    max_level            INT           NOT NULL CHECK (max_level > 0),
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE recipe (
    recipe_id           UUID            PRIMARY KEY DEFAULT uuidv7(),
    output_product_id   UUID            NOT NULL REFERENCES product(product_id),
    output_qty          BIGINT          NOT NULL CHECK (output_qty > 0),
    duration            INTERVAL        NOT NULL CHECK (duration > INTERVAL '0'),
    wage_rate_cents_per_sec BIGINT      NOT NULL CHECK (wage_rate_cents_per_sec >= 0),
    -- Salario total de una ejecución = wage_rate_cents_per_sec * EXTRACT(EPOCH FROM duration).
    -- Se calcula en aplicación al iniciar el proceso para evitar drift por
    -- cambios futuros del rate.
    -- Instalación requerida para ejecutar la receta: el agente debe haber
    -- comprado el tipo y su nivel acota la concurrencia (ADR-021).
    installation_type_id UUID           NOT NULL REFERENCES installation_type(installation_type_id),
    name                TEXT            NOT NULL UNIQUE,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_recipe_installation_type ON recipe(installation_type_id);

CREATE TABLE recipe_input (
    recipe_id       UUID    NOT NULL REFERENCES recipe(recipe_id) ON DELETE CASCADE,
    product_id      UUID    NOT NULL REFERENCES product(product_id),
    qty_required    BIGINT  NOT NULL CHECK (qty_required > 0),
    PRIMARY KEY (recipe_id, product_id)
);


-- =============================================================================
-- 2. AGENTES, AUTENTICACIÓN E INSTALACIONES
-- =============================================================================

CREATE TABLE agent (
    agent_id            UUID            PRIMARY KEY DEFAULT uuidv7(),
    username            TEXT            NOT NULL UNIQUE,
    role                agent_role      NOT NULL,
    status              agent_status    NOT NULL DEFAULT 'active',
    capital_available   BIGINT          NOT NULL DEFAULT 0 CHECK (capital_available >= 0),
    capital_reserved    BIGINT          NOT NULL DEFAULT 0 CHECK (capital_reserved >= 0),
    seed_capital        BIGINT          NOT NULL,
    -- Peso de población: SOLO lo usan las ciudades (rol 'city'). Escala su
    -- capital semilla y su parte del reparto de ingreso recurrente. NULL resto.
    population_weight   BIGINT,
    registered_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
    bankrupt_at         TIMESTAMPTZ
);

CREATE INDEX idx_agent_status_active ON agent(status) WHERE status = 'active';

-- Credenciales separadas del agente para mantener el hash fuera de queries
-- de dominio normales y permitir rotación sin tocar la tabla principal.
CREATE TABLE agent_credentials (
    agent_id            UUID            PRIMARY KEY REFERENCES agent(agent_id) ON DELETE CASCADE,
    password_hash       TEXT            NOT NULL,    -- argon2id o bcrypt, decisión de aplicación
    password_updated_at TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- JWT refresh tokens activos. Los access tokens son stateless; los refresh
-- se persisten para poder revocarlos (quiebra, cambio de contraseña).
CREATE TABLE agent_refresh_token (
    token_id        UUID            PRIMARY KEY DEFAULT uuidv7(),
    agent_id        UUID            NOT NULL REFERENCES agent(agent_id) ON DELETE CASCADE,
    token_hash      TEXT            NOT NULL,        -- nunca guardar el token en claro
    issued_at       TIMESTAMPTZ     NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ     NOT NULL,
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX idx_refresh_token_agent ON agent_refresh_token(agent_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_refresh_token_hash ON agent_refresh_token(token_hash) WHERE revoked_at IS NULL;

-- Instalaciones que el agente ha COMPRADO (economía de instalaciones, ADR-021).
-- Una fila por (agente, tipo de instalación). `level` = nº de hectáreas / líneas
-- de producción = presupuesto de concurrencia COMPARTIDO entre todas las recetas
-- de ese tipo. No hay grant inicial: los agentes nacen SIN filas y compran/suben
-- de nivel vía POST /agents/me/installations (el pago va al banco vía fee_ledger).
CREATE TABLE agent_installation (
    agent_id             UUID   NOT NULL REFERENCES agent(agent_id),
    installation_type_id UUID   NOT NULL REFERENCES installation_type(installation_type_id),
    level                INT    NOT NULL CHECK (level > 0),
    PRIMARY KEY (agent_id, installation_type_id)
);


-- =============================================================================
-- 3. ÓRDENES Y TRANSACCIONES
-- (declaradas antes de inventory_lot para resolver FKs hacia trade y proceso)
-- =============================================================================

CREATE TABLE market_order (
    order_id            UUID            PRIMARY KEY DEFAULT uuidv7(),
    agent_id            UUID            NOT NULL REFERENCES agent(agent_id),
    product_id          UUID            NOT NULL REFERENCES product(product_id),
    side                order_side      NOT NULL,
    qty_original        BIGINT          NOT NULL CHECK (qty_original > 0),
    qty_pending         BIGINT          NOT NULL CHECK (qty_pending >= 0),
    limit_price_cents   BIGINT          NOT NULL CHECK (limit_price_cents > 0),
    status              order_status    NOT NULL DEFAULT 'active',
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ     NOT NULL,
    CHECK (qty_pending <= qty_original),
    CHECK (expires_at > created_at)
);

CREATE INDEX idx_orderbook_buy
    ON market_order (product_id, limit_price_cents DESC, created_at ASC)
    WHERE status IN ('active', 'partial') AND side = 'buy';

CREATE INDEX idx_orderbook_sell
    ON market_order (product_id, limit_price_cents ASC, created_at ASC)
    WHERE status IN ('active', 'partial') AND side = 'sell';

CREATE INDEX idx_order_agent_active
    ON market_order (agent_id)
    WHERE status IN ('active', 'partial');

CREATE INDEX idx_order_expiring
    ON market_order (expires_at)
    WHERE status IN ('active', 'partial');

CREATE TABLE trade (
    trade_id            UUID            PRIMARY KEY DEFAULT uuidv7(),
    buy_order_id        UUID            NOT NULL REFERENCES market_order(order_id),
    sell_order_id       UUID            NOT NULL REFERENCES market_order(order_id),
    buyer_agent_id      UUID            NOT NULL REFERENCES agent(agent_id),
    seller_agent_id     UUID            NOT NULL REFERENCES agent(agent_id),
    product_id          UUID            NOT NULL REFERENCES product(product_id),
    qty_executed        BIGINT          NOT NULL CHECK (qty_executed > 0),
    price_cents         BIGINT          NOT NULL CHECK (price_cents > 0),
    fee_buyer_cents     BIGINT          NOT NULL CHECK (fee_buyer_cents >= 0),
    fee_seller_cents    BIGINT          NOT NULL CHECK (fee_seller_cents >= 0),
    executed_at         TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_trade_product_time ON trade (product_id, executed_at DESC);
CREATE INDEX idx_trade_buyer        ON trade (buyer_agent_id, executed_at DESC);
CREATE INDEX idx_trade_seller       ON trade (seller_agent_id, executed_at DESC);
CREATE INDEX idx_trade_buy_order    ON trade (buy_order_id);
CREATE INDEX idx_trade_sell_order   ON trade (sell_order_id);

-- Conversión ejecutada en la ventanilla del banco central (patrón oro).
-- Sin fees. price_cents_per_unit es el bid o el ask de gold_standard según
-- la dirección; total_cents = floor(qty_cent × price / 100) (notionalCents).
-- Declarada aquí (antes de inventory_lot) para resolver la FK
-- inventory_lot.source_conversion_id.
CREATE TABLE gold_conversion (
    conversion_id        UUID                    PRIMARY KEY DEFAULT uuidv7(),
    agent_id             UUID                    NOT NULL REFERENCES agent(agent_id),
    direction            conversion_direction    NOT NULL,
    product_id           UUID                    NOT NULL REFERENCES product(product_id),
    qty_cent             BIGINT                  NOT NULL CHECK (qty_cent > 0),
    price_cents_per_unit BIGINT                  NOT NULL CHECK (price_cents_per_unit > 0),
    total_cents          BIGINT                  NOT NULL CHECK (total_cents >= 0),
    executed_at          TIMESTAMPTZ             NOT NULL DEFAULT now()
);

CREATE INDEX idx_gold_conversion_agent_time ON gold_conversion (agent_id, executed_at DESC);


-- =============================================================================
-- 4. PROCESOS DE TRANSFORMACIÓN
-- =============================================================================

CREATE TABLE transformation_process (
    process_id              UUID            PRIMARY KEY DEFAULT uuidv7(),
    agent_id                UUID            NOT NULL REFERENCES agent(agent_id),
    recipe_id               UUID            NOT NULL REFERENCES recipe(recipe_id),
    executions_planned      INT             NOT NULL CHECK (executions_planned > 0),
    current_execution       INT             NOT NULL DEFAULT 1,
    status                  process_status  NOT NULL DEFAULT 'running',
    wage_paid_cents         BIGINT          NOT NULL CHECK (wage_paid_cents >= 0),
    started_at              TIMESTAMPTZ     NOT NULL DEFAULT now(),
    expected_end_at         TIMESTAMPTZ     NOT NULL,
    actual_end_at           TIMESTAMPTZ,
    CHECK (current_execution <= executions_planned),
    CHECK (expected_end_at > started_at)
);

CREATE INDEX idx_process_running_expired
    ON transformation_process (expected_end_at)
    WHERE status = 'running';

CREATE INDEX idx_process_agent_running
    ON transformation_process (agent_id)
    WHERE status = 'running';


-- =============================================================================
-- 5. INVENTARIO POR LOTES (FIFO)
-- =============================================================================
--
-- Cada adquisición o producción genera un lote con su precio unitario de
-- adquisición (costo de inventario). Las ventas y consumos de transformación
-- descuentan FIFO: primero los lotes más antiguos.
--
-- La reserva para órdenes de venta se hace a nivel de lote para que el costo
-- del producto vendido sea trazable al lote específico (COGS por trade).
--
-- Cálculo del unit_cost_cents:
--   * origin='purchase':    (price_cents × qty + fee_buyer prorrateado) / qty
--   * origin='production':  (Σ unit_cost de insumos consumidos × qty consumida + salario_pagado) / qty_producida
--   * origin='initial':     0 (o costo nominal de setup)
-- =============================================================================

CREATE TABLE inventory_lot (
    lot_id              UUID                    PRIMARY KEY DEFAULT uuidv7(),
    agent_id            UUID                    NOT NULL REFERENCES agent(agent_id),
    product_id          UUID                    NOT NULL REFERENCES product(product_id),
    origin              inventory_lot_origin    NOT NULL,
    qty_original        BIGINT                  NOT NULL CHECK (qty_original > 0),
    qty_available       BIGINT                  NOT NULL CHECK (qty_available >= 0),
    qty_reserved        BIGINT                  NOT NULL DEFAULT 0 CHECK (qty_reserved >= 0),
    unit_cost_cents     BIGINT                  NOT NULL CHECK (unit_cost_cents >= 0),
    acquired_at         TIMESTAMPTZ             NOT NULL DEFAULT now(),
    source_trade_id     UUID                    REFERENCES trade(trade_id),
    source_process_id   UUID                    REFERENCES transformation_process(process_id),
    source_conversion_id UUID                   REFERENCES gold_conversion(conversion_id),
    CHECK (qty_available + qty_reserved <= qty_original),
    CHECK (
        (origin = 'purchase'   AND source_trade_id      IS NOT NULL AND source_process_id IS NULL     AND source_conversion_id IS NULL) OR
        (origin = 'production' AND source_process_id    IS NOT NULL AND source_trade_id   IS NULL     AND source_conversion_id IS NULL) OR
        (origin = 'conversion' AND source_conversion_id IS NOT NULL AND source_trade_id   IS NULL     AND source_process_id    IS NULL) OR
        (origin = 'initial'    AND source_trade_id      IS NULL     AND source_process_id IS NULL     AND source_conversion_id IS NULL)
    )
);

-- Índice clave para consumo FIFO. UUIDv7 desempata por tiempo de creación
-- si dos lotes tienen el mismo acquired_at.
CREATE INDEX idx_lot_fifo
    ON inventory_lot (agent_id, product_id, acquired_at, lot_id)
    WHERE qty_available > 0 OR qty_reserved > 0;

CREATE INDEX idx_lot_source_trade      ON inventory_lot(source_trade_id)      WHERE source_trade_id      IS NOT NULL;
CREATE INDEX idx_lot_source_process    ON inventory_lot(source_process_id)    WHERE source_process_id    IS NOT NULL;
CREATE INDEX idx_lot_source_conversion ON inventory_lot(source_conversion_id) WHERE source_conversion_id IS NOT NULL;


-- =============================================================================
-- 6. TRAZABILIDAD DE CONSUMO DE LOTES
-- =============================================================================

-- Trazabilidad lote → trade en ventas. Cuando un trade descuenta lotes FIFO
-- del vendedor, se registra qué lotes y cuánto de cada uno se consumió.
-- Permite reconstruir COGS por trade.
CREATE TABLE trade_lot_consumption (
    trade_id            UUID    NOT NULL REFERENCES trade(trade_id) ON DELETE CASCADE,
    lot_id              UUID    NOT NULL REFERENCES inventory_lot(lot_id),
    qty_consumed        BIGINT  NOT NULL CHECK (qty_consumed > 0),
    unit_cost_cents     BIGINT  NOT NULL CHECK (unit_cost_cents >= 0),  -- snapshot del costo
    PRIMARY KEY (trade_id, lot_id)
);

-- Insumos consumidos al iniciar un proceso, trazables a los lotes específicos.
-- Permite calcular costo del producto producido y auditar origen de insumos.
CREATE TABLE transformation_lot_consumption (
    process_id          UUID    NOT NULL REFERENCES transformation_process(process_id) ON DELETE CASCADE,
    lot_id              UUID    NOT NULL REFERENCES inventory_lot(lot_id),
    product_id          UUID    NOT NULL REFERENCES product(product_id),
    qty_consumed        BIGINT  NOT NULL CHECK (qty_consumed > 0),
    unit_cost_cents     BIGINT  NOT NULL CHECK (unit_cost_cents >= 0),
    PRIMARY KEY (process_id, lot_id)
);

-- Lotes consumidos por una conversión de la ventanilla (FIFO del lado que
-- entrega el oro: el agente en sell_gold, el banco en buy_gold). Espejo de
-- trade_lot_consumption para COGS/auditoría.
CREATE TABLE conversion_lot_consumption (
    conversion_id       UUID    NOT NULL REFERENCES gold_conversion(conversion_id) ON DELETE CASCADE,
    lot_id              UUID    NOT NULL REFERENCES inventory_lot(lot_id),
    qty_consumed        BIGINT  NOT NULL CHECK (qty_consumed > 0),
    unit_cost_cents     BIGINT  NOT NULL CHECK (unit_cost_cents >= 0),
    PRIMARY KEY (conversion_id, lot_id)
);

-- Ledger append-only de dinero acreditado al banco central (ADR-019). Dos
-- fuentes: (a) fees de matching (un registro por orden que genera fees, suma de
-- ambos lados; `trade_id` set) y (b) pagos de compra/mejora de instalaciones
-- (ADR-021; `trade_id` NULL). El hot path INSERTA en vez de hacer UPDATE de la
-- fila caliente del banco, eliminando la contención global entre las N réplicas
-- del Core. Un sweeper del Worker pliega periódicamente los registros no
-- materializados al capital del banco (marcándolos materialized). El saldo real
-- del banco = agent.capital_available + SUM(amount_cents) WHERE NOT materialized.
CREATE TABLE fee_ledger (
    fee_id          UUID            PRIMARY KEY DEFAULT uuidv7(),
    -- NULL cuando el ingreso no proviene de un trade (pago de instalación).
    trade_id        UUID            REFERENCES trade(trade_id) ON DELETE CASCADE,
    amount_cents    BIGINT          NOT NULL CHECK (amount_cents > 0),
    materialized    BOOLEAN         NOT NULL DEFAULT false,
    occurred_at     TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- Índice parcial para el sweeper: solo escanea lo pendiente de materializar.
CREATE INDEX idx_fee_ledger_pending ON fee_ledger (fee_id) WHERE NOT materialized;


-- Origen de una fila de income_ledger (flujo circular de ingreso de ciudades):
-- 'wage' = salario reciclado de un proceso (antes se destruía);
-- 'tax'  = fracción del fee de un trade (tasa de consumo).
CREATE TYPE income_source AS ENUM (
    'wage',
    'tax'
);

-- Ledger append-only del ingreso recurrente de las ciudades (gemelo de
-- fee_ledger, ADR-019). El hot path INSERTA: el pago de salario
-- (transformation-service) y el split del fee (order-service). El
-- city-income-sweeper del Worker pliega lo pendiente y lo reparte entre las
-- ciudades activas ponderado por population_weight. Dinero en tránsito (aún no
-- repartido) = SUM(amount_cents) WHERE NOT materialized; cuenta en la
-- conservación monetaria.
CREATE TABLE income_ledger (
    income_id           UUID            PRIMARY KEY DEFAULT uuidv7(),
    amount_cents        BIGINT          NOT NULL CHECK (amount_cents > 0),
    source              income_source   NOT NULL,
    source_process_id   UUID            REFERENCES transformation_process(process_id) ON DELETE CASCADE,
    source_trade_id     UUID            REFERENCES trade(trade_id) ON DELETE CASCADE,
    materialized        BOOLEAN         NOT NULL DEFAULT false,
    occurred_at         TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- Índice parcial para el sweeper: solo escanea lo pendiente de materializar.
CREATE INDEX idx_income_ledger_pending ON income_ledger (income_id) WHERE NOT materialized;


-- =============================================================================
-- 7. EVENT LOG (append-only, sin particionado en v1)
-- =============================================================================

CREATE TABLE event_log (
    event_id        UUID            PRIMARY KEY DEFAULT uuidv7(),
    event_type      event_type      NOT NULL,
    agent_id        UUID            REFERENCES agent(agent_id),  -- nullable: eventos del sistema
    payload         JSONB           NOT NULL,                    -- esquema libre por event_type
    occurred_at     TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_event_log_agent_time
    ON event_log (agent_id, occurred_at DESC)
    WHERE agent_id IS NOT NULL;

CREATE INDEX idx_event_log_type_time
    ON event_log (event_type, occurred_at DESC);

CREATE INDEX idx_event_log_time
    ON event_log (occurred_at DESC);


-- =============================================================================
-- 8. SNAPSHOTS AGREGADOS (disparados manualmente)
-- =============================================================================

CREATE TABLE market_snapshot (
    snapshot_id             UUID            PRIMARY KEY DEFAULT uuidv7(),
    taken_at                TIMESTAMPTZ     NOT NULL DEFAULT now(),
    active_agents           INT             NOT NULL,
    total_money_cents       BIGINT          NOT NULL,
    fees_collected_cents    BIGINT          NOT NULL,
    -- Patrón oro: estado del banco central y del yacimiento al momento del
    -- snapshot. NULL si la corrida no tiene gold_standard sembrado.
    bank_money_cents        BIGINT,                     -- capital total del banco
    bank_gold_qty_cent      BIGINT,                     -- oro disponible del banco
    deposit_remaining_cent  BIGINT,                     -- yacimiento minable restante
    money_issued_cents      BIGINT,                     -- acuñado post-seed acumulado
    money_burned_cents      BIGINT,                     -- destruido post-seed acumulado
    wages_paid_cents        BIGINT,                     -- Σ salarios (único sumidero)
    -- Invariante de conservación (debe ser 0):
    --   Σ capital de TODOS los agentes + wages_paid
    --   − initial_money − money_issued + money_burned
    conservation_delta_cents BIGINT,
    note                    TEXT,                       -- por qué se disparó este snapshot
    UNIQUE (taken_at)
);

CREATE TABLE market_snapshot_agent_capital (
    snapshot_id     UUID    NOT NULL REFERENCES market_snapshot(snapshot_id) ON DELETE CASCADE,
    agent_id        UUID    NOT NULL REFERENCES agent(agent_id),
    capital_total   BIGINT  NOT NULL,
    PRIMARY KEY (snapshot_id, agent_id)
);

CREATE TABLE market_snapshot_product (
    snapshot_id     UUID    NOT NULL REFERENCES market_snapshot(snapshot_id) ON DELETE CASCADE,
    product_id      UUID    NOT NULL REFERENCES product(product_id),
    total_inventory BIGINT  NOT NULL,
    best_bid_cents  BIGINT,
    best_ask_cents  BIGINT,
    PRIMARY KEY (snapshot_id, product_id)
);


-- =============================================================================
-- 9. PATRÓN ORO: YACIMIENTO FINITO Y BANCO CENTRAL
-- =============================================================================
--
-- resource_deposit: stock global FINITO de un recurso primario. La receta que
-- produce ese producto agota el depósito al materializarse (clamp: se produce
-- min(remaining, producido); al llegar a 0 el producto deja de ser minable).
-- El tamaño inicial se sortea en el seed con rngFor(MASTER_SEED, ...).
-- Genérica por product_id para admitir otros recursos finitos en el futuro;
-- en v1 solo se siembra para el oro (GOLD_PRODUCT_KEY).
CREATE TABLE resource_deposit (
    product_id          UUID            PRIMARY KEY REFERENCES product(product_id),
    -- >= 0: con GOLD_BANK_INITIAL_RESERVE_BPS=10000 todo el sorteo va al banco
    -- y el yacimiento minable arranca en 0 (producto no minable desde el inicio).
    qty_initial_cent    BIGINT          NOT NULL CHECK (qty_initial_cent >= 0),
    qty_remaining_cent  BIGINT          NOT NULL CHECK (qty_remaining_cent >= 0),
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    CHECK (qty_remaining_cent <= qty_initial_cent)
);

-- gold_standard: singleton con la política monetaria de la corrida, escrita
-- por el seed y FIJA en runtime salvo los contadores de emisión/destrucción.
--   * parity: cents por unidad entera de oro; ventanilla en [bid, ask].
--   * initial_money_cents: masa sembrada (agentes de mercado + banco).
--   * money_issued_cents: acuñado post-seed (sell_gold + registros).
--   * money_burned_cents: destruido post-seed (buy_gold).
-- Invariante de respaldo: (issued − burned) ≤ capacidad(oro del banco,
-- parity, coverage). La fila se toma FOR UPDATE como mutex de la política
-- (ventanilla y emisión de registro); el matching NUNCA la toca.
CREATE TABLE gold_standard (
    singleton               BOOLEAN         PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    bank_agent_id           UUID            NOT NULL REFERENCES agent(agent_id),
    product_id              UUID            NOT NULL REFERENCES product(product_id),
    parity_cents_per_unit   BIGINT          NOT NULL CHECK (parity_cents_per_unit > 0),
    window_bid_cents        BIGINT          NOT NULL CHECK (window_bid_cents > 0),
    window_ask_cents        BIGINT          NOT NULL,
    coverage_ratio_bps      BIGINT          NOT NULL CHECK (coverage_ratio_bps > 0),
    initial_money_cents     BIGINT          NOT NULL CHECK (initial_money_cents >= 0),
    money_issued_cents      BIGINT          NOT NULL DEFAULT 0 CHECK (money_issued_cents >= 0),
    money_burned_cents      BIGINT          NOT NULL DEFAULT 0 CHECK (money_burned_cents >= 0),
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT now(),
    CHECK (window_ask_cents >= window_bid_cents)
);


-- =============================================================================
-- 10. CONFIGURACIÓN DE CORRIDA
-- =============================================================================
-- La configuración de la simulación (semilla maestra, parámetros de fees,
-- factor de tiempo, rangos de capital por rol, etc.) se carga desde variables
-- de entorno (.env) al arrancar el proceso. Cada core de simulación es único
-- y la configuración es estática durante la corrida.
-- =============================================================================
