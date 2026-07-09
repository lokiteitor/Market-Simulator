package main

import (
	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

type TransformerStrategy struct {
	basePrices map[string]int64
}

func NewTransformerStrategy() *TransformerStrategy {
	return &TransformerStrategy{
		basePrices: make(map[string]int64),
	}
}

func (s *TransformerStrategy) Initialize(ctx *strategy.Context) error {
	ctx.Logger.Info("TransformerStrategy initializing...")
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
	ctx.Logger.Info("TransformerStrategy initialized", "prices", s.basePrices)
	return nil
}

func (s *TransformerStrategy) Tick(ctx *strategy.Context) []actions.Action {
	var acts []actions.Action
	ctx.Logger.Info("TransformerStrategy tick starting...")

	capacities := ctx.State.Capacities()
	activeOrders := ctx.State.ActiveOrders()
	capitalAvail, _ := ctx.State.Capital()

	// Map of active orders by side and product
	activeBuyQty := make(map[string]int64)
	activeSellQty := make(map[string]int64)
	for _, order := range activeOrders {
		if order.Side == models.SideBuy {
			activeBuyQty[order.ProductID] += order.QtyPendingCent
		} else {
			activeSellQty[order.ProductID] += order.QtyPendingCent
		}
	}

	// 1. Process transformations and check if we need to purchase inputs
	for _, capStatus := range capacities {
		recipe, ok := ctx.State.Recipe(capStatus.RecipeID)
		if !ok || len(recipe.Inputs) == 0 {
			continue // Skip recipes with no inputs (handled by producers)
		}

		// A. Determine how many executions we can run right now with available inventory
		maxExecutions := capStatus.AvailableSlots
		for _, input := range recipe.Inputs {
			inv := ctx.State.InventoryForProduct(input.ProductID)
			possible := int(inv.QtyAvailableCent / input.QtyRequiredCent)
			if possible < maxExecutions {
				maxExecutions = possible
			}
		}

		if maxExecutions > 0 {
			ctx.Logger.Info("Starting transformation process", "recipe_id", recipe.RecipeID, "executions", maxExecutions)
			acts = append(acts, actions.StartTransformation{
				RecipeID:          recipe.RecipeID,
				ExecutionsPlanned: maxExecutions,
			})
			// Subtract slots optimistically for the rest of the tick
			capStatus.AvailableSlots -= maxExecutions
		}

		// B. Check if we need to order more inputs to maintain a healthy raw material buffer
		for _, input := range recipe.Inputs {
			inv := ctx.State.InventoryForProduct(input.ProductID)
			// Target: maintain enough inputs for 5 executions per installation
			targetQty := input.QtyRequiredCent * int64(capStatus.Installations) * 5
			currentQty := inv.QtyAvailableCent + activeBuyQty[input.ProductID]

			if currentQty < targetQty {
				qtyToBuy := targetQty - currentQty
				price := int64(80) // Default buy price: 0.80 cents per unit
				if bp, ok := s.basePrices[input.ProductID]; ok {
					price = bp
				}

				// Check budget limits
				maxAffordable := capitalAvail / price
				if qtyToBuy > maxAffordable {
					qtyToBuy = maxAffordable
				}

				if qtyToBuy > 0 {
					ctx.Logger.Info("Placing buy order for inputs", "product_id", input.ProductID, "qty_cent", qtyToBuy, "price_cents", price)
					acts = append(acts, actions.PlaceOrder{
						ProductID:       input.ProductID,
						Side:            models.SideBuy,
						QtyCent:         qtyToBuy,
						LimitPriceCents: price,
						TTLSeconds:      300,
					})
					// Subtract capital optimistically
					capitalAvail -= qtyToBuy * price
					activeBuyQty[input.ProductID] += qtyToBuy
				}
			}
		}
	}

	// 2. Sell produced outputs in inventory
	inventory := ctx.State.Inventory()
	for _, pos := range inventory {
		// Only sell products that are outputs of recipes we have capacity for
		isOutput := false
		var matchedRecipe models.Recipe
		for _, capStatus := range capacities {
			recipe, ok := ctx.State.Recipe(capStatus.RecipeID)
			if ok && recipe.OutputProductID == pos.ProductID {
				isOutput = true
				matchedRecipe = recipe
				break
			}
		}

		if !isOutput {
			continue // Do not sell raw materials or unrelated products
		}

		unlistedQty := pos.QtyAvailableCent - activeSellQty[pos.ProductID]
		if unlistedQty > 0 {
			price := int64(150) // Default sell price: 1.50 cents per unit
			if bp, ok := s.basePrices[pos.ProductID]; ok {
				price = bp
			} else {
				// Estimate cost of production = inputs cost + wage cost
				var inputCosts int64
				for _, inp := range matchedRecipe.Inputs {
					inPrice := int64(100)
					if bp, ok := s.basePrices[inp.ProductID]; ok {
						inPrice = bp
					}
					inputCosts += inp.QtyRequiredCent * inPrice
				}
				wageCost := matchedRecipe.WageRateCentsPerSec * matchedRecipe.DurationSeconds
				totalCost := inputCosts + wageCost
				if matchedRecipe.OutputQtyCent > 0 {
					costPerUnit := totalCost / matchedRecipe.OutputQtyCent
					price = int64(float64(costPerUnit) * 1.3) // 30% margin
				}
			}

			if price > 0 {
				ctx.Logger.Info("Placing sell order for output", "product_id", pos.ProductID, "qty_cent", unlistedQty, "price_cents", price)
				acts = append(acts, actions.PlaceOrder{
					ProductID:       pos.ProductID,
					Side:            models.SideSell,
					QtyCent:         unlistedQty,
					LimitPriceCents: price,
					TTLSeconds:      300,
				})
			}
		}
	}

	return acts
}

func (s *TransformerStrategy) HandleEvent(ctx *strategy.Context, e events.Event) []actions.Action {
	switch ev := e.(type) {
	case events.OrderExecuted:
		ctx.Logger.Info("Transformer order executed", "order_id", ev.OrderID, "product_id", ev.ProductID, "qty", ev.QtyExecutedCent, "price", ev.PriceCents)
	case events.TransformationCompleted:
		ctx.Logger.Info("Transformer transformation completed", "process_id", ev.ProcessID, "recipe_id", ev.RecipeID)
	case events.BankruptcyNotice:
		ctx.Logger.Warn("Transformer bankruptcy notice received!", "agent_id", ev.AgentID)
	}
	return nil
}
