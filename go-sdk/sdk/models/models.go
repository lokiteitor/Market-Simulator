package models

import "time"

type AgentRole string

const (
	RoleTransformer     AgentRole = "transformer"
	RoleConsumer        AgentRole = "consumer"
	RoleTrader          AgentRole = "trader"
	// RoleCity: consumidor sembrado (capital del mundo). No registrable por
	// humanos; el backend lo siembra y bots-ciudad lo maneja por login.
	RoleCity AgentRole = "city"
)

type AgentStatus string

const (
	StatusActive   AgentStatus = "active"
	StatusBankrupt AgentStatus = "bankrupt"
)

type AgentPublic struct {
	AgentID      string      `json:"agent_id"`
	Username     string      `json:"username"`
	Role         AgentRole   `json:"role"`
	Status       AgentStatus `json:"status"`
	RegisteredAt time.Time   `json:"registered_at"`
	BankruptAt   *time.Time  `json:"bankrupt_at,omitempty"`
}

type ProductCategory string

const (
	CategoryRawPrimary       ProductCategory = "raw_primary"
	CategoryIntermediate     ProductCategory = "intermediate"
	CategoryFinalConsumption ProductCategory = "final_consumption"
)

type Product struct {
	ProductID string `json:"product_id"`
	// Key es el identificador estable del catálogo (ej. "trigo"); a diferencia
	// de ProductID (UUID regenerado en cada seed) es constante entre despliegues.
	Key       string          `json:"key"`
	Name      string          `json:"name"`
	Unit      string          `json:"unit"`
	Category  ProductCategory `json:"category"`
	CreatedAt time.Time       `json:"created_at"`
}

type RecipeInput struct {
	ProductID       string `json:"product_id"`
	QtyRequiredCent int64  `json:"qty_required_cent"`
}

type Recipe struct {
	RecipeID            string `json:"recipe_id"`
	Name                string `json:"name"`
	OutputProductID     string `json:"output_product_id"`
	OutputQtyCent       int64  `json:"output_qty_cent"`
	DurationSeconds     int64  `json:"duration_seconds"`
	WageRateCentsPerSec int64  `json:"wage_rate_cents_per_sec"`
	// Tipo de instalación requerido para ejecutar la receta (ADR-021).
	InstallationTypeID string        `json:"installation_type_id"`
	Inputs             []RecipeInput `json:"inputs"`
	CreatedAt          time.Time     `json:"created_at"`
}

// InstallationStatus: una instalación comprada por el agente (ADR-021). El nivel
// es el presupuesto de concurrencia COMPARTIDO por todas las recetas del tipo.
type InstallationStatus struct {
	InstallationType      string `json:"installation_type"`
	Name                  string `json:"name"`
	UnitLabel             string `json:"unit_label"`
	Level                 int    `json:"level"`
	Running               int    `json:"running"`
	AvailableSlots        int    `json:"available_slots"`
	NextUpgradePriceCents *int64 `json:"next_upgrade_price_cents"`
}

// InstallationType: un tipo comprable del catálogo (GET /catalog/installation-types).
type InstallationType struct {
	InstallationTypeID string `json:"installation_type_id"`
	Key                string `json:"key"`
	Name               string `json:"name"`
	Role               string `json:"role"`
	UnitLabel          string `json:"unit_label"`
	BasePriceCents     int64  `json:"base_price_cents"`
	GrowthBps          int    `json:"growth_bps"`
	MaxLevel           int    `json:"max_level"`
}

// Deposit es el yacimiento finito de un recurso no renovable (ADR-023).
//
// A diferencia del resto del catálogo NO es estático: YieldBps baja a medida
// que el yacimiento se vacía y multiplica el output real de la receta, así que
// una estrategia que valore recetas con OutputQtyCent a pelo sobreestima lo que
// va a producir. Se refresca periódicamente vía GET /catalog/deposits.
type Deposit struct {
	ProductID  string `json:"product_id"`
	ProductKey string `json:"product_key"`
	// QtyInitialCent es el tamaño sorteado en el seed; QtyRemainingCent, lo que
	// queda por extraer.
	QtyInitialCent   int64 `json:"qty_initial_cent"`
	QtyRemainingCent int64 `json:"qty_remaining_cent"`
	// YieldBps: rendimiento sobre el output nominal (10000 = 100%, 0 = agotado).
	YieldBps int64 `json:"yield_bps"`
}

type InventoryPosition struct {
	ProductID        string `json:"product_id"`
	QtyAvailableCent int64  `json:"qty_available_cent"`
	QtyReservedCent  int64  `json:"qty_reserved_cent"`
}

type InventoryLotOrigin string

const (
	OriginInitial    InventoryLotOrigin = "initial"
	OriginProduction InventoryLotOrigin = "production"
	OriginPurchase   InventoryLotOrigin = "purchase"
)

type InventoryLot struct {
	LotID            string             `json:"lot_id"`
	ProductID        string             `json:"product_id"`
	Origin           InventoryLotOrigin `json:"origin"`
	QtyOriginalCent  int64              `json:"qty_original_cent"`
	QtyAvailableCent int64              `json:"qty_available_cent"`
	QtyReservedCent  int64              `json:"qty_reserved_cent"`
	UnitCostCents    int64              `json:"unit_cost_cents"`
	AcquiredAt       time.Time          `json:"acquired_at"`
	SourceTradeID    *string            `json:"source_trade_id,omitempty"`
	SourceProcessID  *string            `json:"source_process_id,omitempty"`
}

type OrderSide string

const (
	SideBuy  OrderSide = "buy"
	SideSell OrderSide = "sell"
)

type OrderStatus string

const (
	OrderStatusActive    OrderStatus = "active"
	OrderStatusPartial   OrderStatus = "partial"
	OrderStatusCompleted OrderStatus = "completed"
	OrderStatusCancelled OrderStatus = "cancelled"
	OrderStatusExpired   OrderStatus = "expired"
)

type Order struct {
	OrderID         string      `json:"order_id"`
	AgentID         string      `json:"agent_id"`
	ProductID       string      `json:"product_id"`
	Side            OrderSide   `json:"side"`
	QtyOriginalCent int64       `json:"qty_original_cent"`
	QtyPendingCent  int64       `json:"qty_pending_cent"`
	LimitPriceCents int64       `json:"limit_price_cents"`
	Status          OrderStatus `json:"status"`
	CreatedAt       time.Time   `json:"created_at"`
	UpdatedAt       time.Time   `json:"updated_at"`
	ExpiresAt       time.Time   `json:"expires_at"`
}

type OrderPage struct {
	Items      []Order `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

type Trade struct {
	TradeID         string    `json:"trade_id"`
	BuyOrderID      string    `json:"buy_order_id"`
	SellOrderID     string    `json:"sell_order_id"`
	BuyerAgentID    string    `json:"buyer_agent_id"`
	SellerAgentID   string    `json:"seller_agent_id"`
	ProductID       string    `json:"product_id"`
	QtyExecutedCent int64     `json:"qty_executed_cent"`
	PriceCents      int64     `json:"price_cents"`
	FeeBuyerCents   int64     `json:"fee_buyer_cents"`
	FeeSellerCents  int64     `json:"fee_seller_cents"`
	ExecutedAt      time.Time `json:"executed_at"`
}

type TradePage struct {
	Items      []Trade `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

// TradesQuery filtra GET /market/{id}/trades. Since/Until acotan executed_at
// (RFC 3339); Before es un trade_id cursor para paginar hacia atrás (devuelve
// trades estrictamente anteriores a ese trade). Limit máximo del servidor: 1000.
type TradesQuery struct {
	Since  string
	Until  string
	Before string
	Limit  int
}

type TopOfBookSide struct {
	OrderID        string `json:"order_id"`
	AgentID        string `json:"agent_id"`
	PriceCents     int64  `json:"price_cents"`
	QtyPendingCent int64  `json:"qty_pending_cent"`
}

type TopOfBook struct {
	ProductID  string         `json:"product_id"`
	ObservedAt time.Time      `json:"observed_at"`
	BestBid    *TopOfBookSide `json:"best_bid"`
	BestAsk    *TopOfBookSide `json:"best_ask"`
}

type ProcessStatus string

const (
	ProcessRunning   ProcessStatus = "running"
	ProcessCompleted ProcessStatus = "completed"
	ProcessCancelled ProcessStatus = "cancelled"
)

type TransformationProcess struct {
	ProcessID         string        `json:"process_id"`
	AgentID           string        `json:"agent_id"`
	RecipeID          string        `json:"recipe_id"`
	ExecutionsPlanned int           `json:"executions_planned"`
	CurrentExecution  int           `json:"current_execution"`
	Status            ProcessStatus `json:"status"`
	WagePaidCents     int64         `json:"wage_paid_cents"`
	StartedAt         time.Time     `json:"started_at"`
	ExpectedEndAt     time.Time     `json:"expected_end_at"`
	ActualEndAt       *time.Time    `json:"actual_end_at,omitempty"`
}

type LotConsumption struct {
	LotID           string `json:"lot_id"`
	ProductID       string `json:"product_id"`
	QtyConsumedCent int64  `json:"qty_consumed_cent"`
	UnitCostCents   int64  `json:"unit_cost_cents"`
}

type TransformationProcessDetail struct {
	TransformationProcess
	InputsConsumed []LotConsumption `json:"inputs_consumed"`
	ProducedLot    *InventoryLot    `json:"produced_lot,omitempty"`
}

type TransformationPage struct {
	Items      []TransformationProcess `json:"items"`
	NextCursor *string                 `json:"next_cursor"`
}

type EventType string

const (
	EventAgentRegistered  EventType = "agent_registered"
	EventAgentBankrupt    EventType = "agent_bankrupt"
	EventOrderPlaced      EventType = "order_placed"
	EventOrderCancelled   EventType = "order_cancelled"
	EventOrderExpired     EventType = "order_expired"
	EventTradeExecuted    EventType = "trade_executed"
	EventProcessStarted   EventType = "process_started"
	EventProcessCompleted EventType = "process_completed"
	EventProcessCancelled EventType = "process_cancelled"
	EventSnapshotTaken    EventType = "snapshot_taken"

	// Websocket-specific events
	EventOrderExecuted           EventType = "order_executed"
	EventTransformationCompleted EventType = "transformation_completed"
	EventBankruptcyNotice        EventType = "bankruptcy_notice"
	EventAgentJoined             EventType = "agent_joined"
)

type Event struct {
	EventID    string                 `json:"event_id"`
	EventType  EventType              `json:"event_type"`
	AgentID    *string                `json:"agent_id"`
	OccurredAt time.Time              `json:"occurred_at"`
	Payload    map[string]interface{} `json:"payload"`
}

type EventPage struct {
	Items      []Event `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

type AgentSnapshot struct {
	Agent                 AgentPublic             `json:"agent"`
	CapitalAvailableCents int64                   `json:"capital_available_cents"`
	CapitalReservedCents  int64                   `json:"capital_reserved_cents"`
	Inventory             []InventoryPosition     `json:"inventory"`
	ActiveOrders          []Order                 `json:"active_orders"`
	RunningProcesses      []TransformationProcess `json:"running_processes"`
	Installations         []InstallationStatus    `json:"installations"`
	RecentEvents          []Event                 `json:"recent_events"`
}

// Request and Response helper structures

type RegisterAgentRequest struct {
	Username string    `json:"username"`
	Password string    `json:"password"`
	Role     AgentRole `json:"role"`
}

// AcquireInstallationRequest: body de POST /agents/me/installations (ADR-021).
type AcquireInstallationRequest struct {
	InstallationType     string `json:"installation_type"`
	ExpectedCurrentLevel *int   `json:"expected_current_level,omitempty"`
}

// AcquireInstallationResponse: InstallationStatus + lo cobrado.
type AcquireInstallationResponse struct {
	InstallationStatus
	AmountChargedCents int64 `json:"amount_charged_cents"`
}

type RegisterAgentResponse struct {
	TokenPair
	Agent AgentSnapshot `json:"agent"`
}

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type RefreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type TokenPair struct {
	AccessToken      string    `json:"access_token"`
	RefreshToken     string    `json:"refresh_token"`
	TokenType        string    `json:"token_type"`
	AccessExpiresAt  time.Time `json:"access_expires_at"`
	RefreshExpiresAt time.Time `json:"refresh_expires_at"`
}

type PlaceOrderRequest struct {
	ProductID       string    `json:"product_id"`
	Side            OrderSide `json:"side"`
	QtyCent         int64     `json:"qty_cent"`
	LimitPriceCents int64     `json:"limit_price_cents"`
	TTLSeconds      int64     `json:"ttl_seconds"`
	ClientOrderID   string    `json:"client_order_id,omitempty"`
}

type PlaceOrderResponse struct {
	Order
	TradesGenerated []Trade `json:"trades_generated"`
}

type StartTransformationRequest struct {
	RecipeID          string `json:"recipe_id"`
	ExecutionsPlanned int    `json:"executions_planned"`
}

type ErrorDetail struct {
	Code    string  `json:"code"`
	Field   *string `json:"field,omitempty"`
	Message string  `json:"message"`
}

type Problem struct {
	Type     string        `json:"type"`
	Title    string        `json:"title"`
	Status   int           `json:"status"`
	Detail   string        `json:"detail,omitempty"`
	Instance string        `json:"instance,omitempty"`
	Errors   []ErrorDetail `json:"errors,omitempty"`
}

// ---------------------------------------------------------------------------
// Banco central (patrón oro): GET /bank y POST /bank/convert
// ---------------------------------------------------------------------------

type ConversionDirection string

const (
	// BuyGold: el agente compra oro al banco a window_ask (el dinero pagado se destruye).
	BuyGold ConversionDirection = "buy_gold"
	// SellGold: el agente vende oro al banco a window_bid (cobra dinero recién acuñado).
	SellGold ConversionDirection = "sell_gold"
)

type BankInfo struct {
	BankAgentID               string `json:"bank_agent_id"`
	ProductID                 string `json:"product_id"`
	ParityCentsPerUnit        int64  `json:"parity_cents_per_unit"`
	WindowBidCents            int64  `json:"window_bid_cents"`
	WindowAskCents            int64  `json:"window_ask_cents"`
	CoverageRatioBps          int64  `json:"coverage_ratio_bps"`
	InitialMoneyCents         int64  `json:"initial_money_cents"`
	MoneyIssuedCents          int64  `json:"money_issued_cents"`
	MoneyBurnedCents          int64  `json:"money_burned_cents"`
	IssuanceCapacityCents     int64  `json:"issuance_capacity_cents"`
	BankGoldAvailableCent     int64  `json:"bank_gold_available_cent"`
	BankCapitalAvailableCents int64  `json:"bank_capital_available_cents"`
	DepositRemainingCent      *int64 `json:"deposit_remaining_cent"`
}

type ConvertGoldRequest struct {
	Direction ConversionDirection `json:"direction"`
	QtyCent   int64               `json:"qty_cent"`
}

type GoldConversion struct {
	ConversionID      string              `json:"conversion_id"`
	AgentID           string              `json:"agent_id"`
	Direction         ConversionDirection `json:"direction"`
	ProductID         string              `json:"product_id"`
	QtyCent           int64               `json:"qty_cent"`
	PriceCentsPerUnit int64               `json:"price_cents_per_unit"`
	TotalCents        int64               `json:"total_cents"`
	ExecutedAt        time.Time           `json:"executed_at"`
}
