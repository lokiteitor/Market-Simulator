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

type AgentBankrupt struct {
	AgentID    string    `json:"agent_id"`
	Username   string    `json:"username"`
	BankruptAt time.Time `json:"bankrupt_at"`
}

func (e AgentBankrupt) Occurred() time.Time { return e.BankruptAt }

type WSConnected struct {
	ConnectedAt time.Time
}

func (e WSConnected) Occurred() time.Time { return e.ConnectedAt }

