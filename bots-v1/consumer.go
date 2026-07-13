package main

import (
	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

type ConsumerStrategy struct {
	basePrices map[string]int64
}

func NewConsumerStrategy() *ConsumerStrategy {
	return &ConsumerStrategy{
		basePrices: make(map[string]int64),
	}
}

func (s *ConsumerStrategy) Initialize(ctx *strategy.Context) error {
	ctx.Logger.Info("ConsumerStrategy initializing...")
	if pricesRaw, ok := ctx.Config["prices"]; ok {
		if pricesMap, ok := pricesRaw.(map[string]interface{}); ok {
			for k, v := range pricesMap {
				switch val := v.(type) {
				case int:
					s.basePrices[k] = int64(val)
				case int64:
					s.basePrices[k] = val
				case float64:
					s.basePrices[k] = int64(val)
				}
			}
		}
	}
	ctx.Logger.Info("ConsumerStrategy initialized", "prices", s.basePrices)
	return nil
}

func (s *ConsumerStrategy) Tick(ctx *strategy.Context) []actions.Action {
	var acts []actions.Action
	ctx.Logger.Info("ConsumerStrategy tick starting...")

	products := ctx.State.CatalogProducts()
	activeOrders := ctx.State.ActiveOrders()
	capitalAvail, _ := ctx.State.Capital()

	// Map of active buy orders by product
	activeBuyQty := make(map[string]int64)
	for _, order := range activeOrders {
		if order.Side == models.SideBuy {
			activeBuyQty[order.ProductID] += order.QtyPendingCent
		}
	}

	for _, product := range products {
		if product.Category != "final_consumption" {
			continue // Only consume finished/final goods
		}

		// Target to have at least 1000 cent-units (10 units) of pending buy orders
		currentPending := activeBuyQty[product.ProductID]
		if currentPending < 1000 {
			qtyToBuy := int64(1000) - currentPending
			price := int64(150) // Default price: 1.50 cents per unit
			if bp, ok := s.basePrices[product.ProductID]; ok {
				price = bp
			}

			// Ensure we don't spend more than 20% of our available capital on a single order
			maxSpendCents := capitalAvail / 5
			if maxQty := maxQtyForBudget(maxSpendCents, price); qtyToBuy > maxQty {
				qtyToBuy = maxQty
			}

			if isReservable(qtyToBuy, price) {
				ctx.Logger.Info("Placing buy order for consumption", "product_id", product.ProductID, "qty_cent", qtyToBuy, "price_cents", price)
				acts = append(acts, actions.PlaceOrder{
					ProductID:       product.ProductID,
					Side:            models.SideBuy,
					QtyCent:         qtyToBuy,
					LimitPriceCents: price,
					TTLSeconds:      300,
				})
				// Deduct capital optimistically
				capitalAvail -= notionalCents(qtyToBuy, price)
			}
		}
	}

	return acts
}

func (s *ConsumerStrategy) HandleEvent(ctx *strategy.Context, e events.Event) []actions.Action {
	switch ev := e.(type) {
	case events.OrderExecuted:
		ctx.Logger.Info("Consumer order executed (consumed final product)", "order_id", ev.OrderID, "product_id", ev.ProductID, "qty", ev.QtyExecutedCent, "price", ev.PriceCents)
	case events.BankruptcyNotice:
		ctx.Logger.Warn("Consumer bankruptcy notice received!", "agent_id", ev.AgentID)
	}
	return nil
}
