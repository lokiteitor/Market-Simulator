package actions

import "github.com/lokiteitor/market-simulator/sdk/models"

type ActionType string

const (
	TypePlaceOrder        ActionType = "place_order"
	TypeCancelOrder       ActionType = "cancel_order"
	TypeStartTransformation ActionType = "start_transformation"
	TypeConvertGold       ActionType = "convert_gold"
	TypeSleep             ActionType = "sleep"
)

type Action interface {
	Type() ActionType
}

type PlaceOrder struct {
	ProductID       string           `json:"product_id"`
	Side            models.OrderSide `json:"side"`
	QtyCent         int64            `json:"qty_cent"`
	LimitPriceCents int64            `json:"limit_price_cents"`
	TTLSeconds      int64            `json:"ttl_seconds"`
	ClientOrderID   string           `json:"client_order_id,omitempty"`
}

func (a PlaceOrder) Type() ActionType { return TypePlaceOrder }

type CancelOrder struct {
	OrderID string `json:"order_id"`
}

func (a CancelOrder) Type() ActionType { return TypeCancelOrder }

type StartTransformation struct {
	RecipeID          string `json:"recipe_id"`
	ExecutionsPlanned int    `json:"executions_planned"`
}

func (a StartTransformation) Type() ActionType { return TypeStartTransformation }

// ConvertGold opera la ventanilla del banco central (patrón oro):
// sell_gold cobra dinero acuñado a window_bid; buy_gold paga a window_ask.
type ConvertGold struct {
	Direction models.ConversionDirection `json:"direction"`
	QtyCent   int64                      `json:"qty_cent"`
}

func (a ConvertGold) Type() ActionType { return TypeConvertGold }

type Sleep struct {
	DurationSeconds int64 `json:"duration_seconds"`
}

func (a Sleep) Type() ActionType { return TypeSleep }
