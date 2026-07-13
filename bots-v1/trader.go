package main

import (
	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

type TraderStrategy struct {
	basePrices map[string]int64
}

func NewTraderStrategy() *TraderStrategy {
	return &TraderStrategy{
		basePrices: make(map[string]int64),
	}
}

func (s *TraderStrategy) Initialize(ctx *strategy.Context) error {
	ctx.Logger.Info("TraderStrategy initializing...")
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
	ctx.Logger.Info("TraderStrategy initialized", "prices", s.basePrices)
	return nil
}

func (s *TraderStrategy) Tick(ctx *strategy.Context) []actions.Action {
	var acts []actions.Action
	ctx.Logger.Info("TraderStrategy tick starting...")

	products := ctx.State.CatalogProducts()
	activeOrders := ctx.State.ActiveOrders()
	capitalAvail, _ := ctx.State.Capital()

	// Map of active buy and sell orders by product
	activeBuyQty := make(map[string]int64)
	activeSellQty := make(map[string]int64)
	for _, order := range activeOrders {
		if order.Side == models.SideBuy {
			activeBuyQty[order.ProductID] += order.QtyPendingCent
		} else {
			activeSellQty[order.ProductID] += order.QtyPendingCent
		}
	}

	for _, product := range products {
		inv := ctx.State.InventoryForProduct(product.ProductID)

		// 1. Sell accumulated inventory with a markup (Sell High)
		unlistedQty := inv.QtyAvailableCent - activeSellQty[product.ProductID]
		if unlistedQty > 0 {
			price := int64(120) // Default sell price: 1.20 cents per unit
			if bp, ok := s.basePrices[product.ProductID]; ok {
				price = int64(float64(bp) * 1.15) // Sell at 15% markup over base price
			}

			if price > 0 {
				ctx.Logger.Info("Trader placing spec sell order", "product_id", product.ProductID, "qty_cent", unlistedQty, "price_cents", price)
				acts = append(acts, actions.PlaceOrder{
					ProductID:       product.ProductID,
					Side:            models.SideSell,
					QtyCent:         unlistedQty,
					LimitPriceCents: price,
					TTLSeconds:      300,
				})
			}
		}

		// 2. Buy products below their base value (Buy Low)
		currentPendingBuy := activeBuyQty[product.ProductID]
		if currentPendingBuy < 500 { // Max 5 units pending buy per product
			qtyToBuy := int64(500) - currentPendingBuy
			price := int64(80) // Default buy price: 0.80 cents per unit
			if bp, ok := s.basePrices[product.ProductID]; ok {
				price = int64(float64(bp) * 0.85) // Buy at 15% discount under base price
			}

			// Ensure we do not spend more than 15% of our available capital on a single product's speculation
			maxSpendCents := capitalAvail / 7
			if maxQty := maxQtyForBudget(maxSpendCents, price); qtyToBuy > maxQty {
				qtyToBuy = maxQty
			}

			if isReservable(qtyToBuy, price) {
				ctx.Logger.Info("Trader placing spec buy order", "product_id", product.ProductID, "qty_cent", qtyToBuy, "price_cents", price)
				acts = append(acts, actions.PlaceOrder{
					ProductID:       product.ProductID,
					Side:            models.SideBuy,
					QtyCent:         qtyToBuy,
					LimitPriceCents: price,
					TTLSeconds:      300,
				})
				capitalAvail -= notionalCents(qtyToBuy, price)
			}
		}
	}

	return acts
}

func (s *TraderStrategy) HandleEvent(ctx *strategy.Context, e events.Event) []actions.Action {
	switch ev := e.(type) {
	case events.OrderExecuted:
		ctx.Logger.Info("Trader order executed", "order_id", ev.OrderID, "product_id", ev.ProductID, "qty", ev.QtyExecutedCent, "price", ev.PriceCents)
	case events.BankruptcyNotice:
		ctx.Logger.Warn("Trader bankruptcy notice received!", "agent_id", ev.AgentID)
	}
	return nil
}
