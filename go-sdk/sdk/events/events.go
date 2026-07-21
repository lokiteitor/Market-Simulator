package events

import "time"

// Event is a marker interface for all domain events.
type Event interface {
	Occurred() time.Time
}

type OrderExecuted struct {
	OrderID         string    `json:"order_id"`
	ProductID       string    `json:"product_id"`
	QtyExecutedCent int64     `json:"qty_executed_cent"`
	PriceCents      int64     `json:"price_cents"`
	ExecutedAt      time.Time `json:"executed_at"`
}

func (e OrderExecuted) Occurred() time.Time { return e.ExecutedAt }

type OrderExpired struct {
	OrderID   string    `json:"order_id"`
	ExpiredAt time.Time `json:"expired_at"`
}

func (e OrderExpired) Occurred() time.Time { return e.ExpiredAt }

type OrderCancelled struct {
	OrderID     string    `json:"order_id"`
	CancelledAt time.Time `json:"cancelled_at"`
}

func (e OrderCancelled) Occurred() time.Time { return e.CancelledAt }

type TransformationCompleted struct {
	ProcessID   string    `json:"process_id"`
	RecipeID    string    `json:"recipe_id"`
	CompletedAt time.Time `json:"completed_at"`
}

func (e TransformationCompleted) Occurred() time.Time { return e.CompletedAt }

type BankruptcyNotice struct {
	AgentID    string    `json:"agent_id"`
	BankruptAt time.Time `json:"bankrupt_at"`
}

func (e BankruptcyNotice) Occurred() time.Time { return e.BankruptAt }

type AgentJoined struct {
	AgentID  string    `json:"agent_id"`
	Username string    `json:"username"`
	Role     string    `json:"role"`
	JoinedAt time.Time `json:"joined_at"`
}

func (e AgentJoined) Occurred() time.Time { return e.JoinedAt }

// TradePrinted es el tape público del mercado: un broadcast por cada trade
// ejecutado, sea o no del agente. Es la señal event-driven para estrategias
// que reaccionan a precio/volumen sin hacer polling REST.
type TradePrinted struct {
	TradeID         string    `json:"trade_id"`
	ProductID       string    `json:"product_id"`
	BuyerAgentID    string    `json:"buyer_agent_id"`
	SellerAgentID   string    `json:"seller_agent_id"`
	QtyExecutedCent int64     `json:"qty_executed_cent"`
	PriceCents      int64     `json:"price_cents"`
	ExecutedAt      time.Time `json:"executed_at"`
}

func (e TradePrinted) Occurred() time.Time { return e.ExecutedAt }

type AgentBankrupt struct {
	AgentID    string    `json:"agent_id"`
	Username   string    `json:"username"`
	BankruptAt time.Time `json:"bankrupt_at"`
}

func (e AgentBankrupt) Occurred() time.Time { return e.BankruptAt }

// GoldConverted: conversión propia ejecutada en la ventanilla del banco
// central (patrón oro). Personal: solo llega al agente que convirtió.
type GoldConverted struct {
	ConversionID      string    `json:"conversion_id"`
	Direction         string    `json:"direction"` // buy_gold | sell_gold
	ProductID         string    `json:"product_id"`
	QtyCent           int64     `json:"qty_cent"`
	PriceCentsPerUnit int64     `json:"price_cents_per_unit"`
	TotalCents        int64     `json:"total_cents"`
	ExecutedAt        time.Time `json:"executed_at"`
}

func (e GoldConverted) Occurred() time.Time { return e.ExecutedAt }

// CityIncome: ingreso recurrente acreditado a una ciudad por el
// city-income-sweeper (flujo circular: salarios reciclados + tasa de consumo).
// Personal: solo llega al agente-ciudad que lo recibió. Sin esto el capital
// local de la ciudad quedaría desactualizado y el bot no gastaría su ingreso.
type CityIncome struct {
	AmountCents int64     `json:"amount_cents"`
	ReceivedAt  time.Time `json:"-"`
}

func (e CityIncome) Occurred() time.Time { return e.ReceivedAt }

// InstallationPurchased: compra o mejora de instalación propia confirmada
// (ADR-021). Personal: solo llega al agente que compró. El payload es el
// estado absoluto de la instalación al commit (camelCase en el wire, a
// diferencia del resto de la API) más el importe cobrado.
type InstallationPurchased struct {
	InstallationType      string    `json:"installationType"`
	Name                  string    `json:"name"`
	UnitLabel             string    `json:"unitLabel"`
	Level                 int       `json:"level"`
	Running               int       `json:"running"`
	AvailableSlots        int       `json:"availableSlots"`
	NextUpgradePriceCents *int64    `json:"nextUpgradePriceCents"`
	AmountChargedCents    int64     `json:"amountChargedCents"`
	PurchasedAt           time.Time `json:"-"`
}

func (e InstallationPurchased) Occurred() time.Time { return e.PurchasedAt }

type WSConnected struct {
	ConnectedAt time.Time
}

func (e WSConnected) Occurred() time.Time { return e.ConnectedAt }

