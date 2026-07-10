package main

import (
	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

type PrimaryProducerStrategy struct {
	basePrices        map[string]int64
	simTimeFactor     float64
	maxRecipesPerTick int
}

func NewPrimaryProducerStrategy() *PrimaryProducerStrategy {
	return &PrimaryProducerStrategy{
		basePrices:        make(map[string]int64),
		simTimeFactor:     5,
		maxRecipesPerTick: 8,
	}
}

func (s *PrimaryProducerStrategy) Initialize(ctx *strategy.Context) error {
	ctx.Logger.Info("PrimaryProducerStrategy initializing...")
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
	s.simTimeFactor = configFloat(ctx.Config, "sim_time_factor", s.simTimeFactor)
	s.maxRecipesPerTick = configInt(ctx.Config, "max_recipes_per_tick", s.maxRecipesPerTick)
	ctx.Logger.Info("PrimaryProducerStrategy initialized", "prices", s.basePrices, "sim_time_factor", s.simTimeFactor, "max_recipes_per_tick", s.maxRecipesPerTick)
	return nil
}

func (s *PrimaryProducerStrategy) Tick(ctx *strategy.Context) []actions.Action {
	var acts []actions.Action
	ctx.Logger.Info("PrimaryProducerStrategy tick starting...")

	// 1. Check capacity and start transformations for recipes with no inputs.
	// Cap por tick: seed-config asigna las 35 recetas primarias a cada productor;
	// iniciar transformaciones de todas cada tick satura al agente y al servidor.
	capacities := ctx.State.Capacities()
	recipesActed := 0
	for _, capStatus := range capacities {
		if capStatus.AvailableSlots > 0 {
			recipe, ok := ctx.State.Recipe(capStatus.RecipeID)
			if ok && len(recipe.Inputs) == 0 {
				if s.maxRecipesPerTick > 0 && recipesActed >= s.maxRecipesPerTick {
					break
				}
				recipesActed++
				ctx.Logger.Info("Starting production transformation", "recipe_id", recipe.RecipeID, "slots", capStatus.AvailableSlots)
				acts = append(acts, actions.StartTransformation{
					RecipeID:          recipe.RecipeID,
					ExecutionsPlanned: capStatus.AvailableSlots,
				})
			}
		}
	}

	// 2. Sell produced goods currently in inventory
	inventory := ctx.State.Inventory()
	activeOrders := ctx.State.ActiveOrders()

	// Map to keep track of active sell orders by product
	activeSellQty := make(map[string]int64)
	for _, order := range activeOrders {
		if order.Side == models.SideSell {
			activeSellQty[order.ProductID] += order.QtyPendingCent
		}
	}

	for _, pos := range inventory {
		// Only sell if we have available quantity that is not already listed in active orders
		unlistedQty := pos.QtyAvailableCent - activeSellQty[pos.ProductID]
		if unlistedQty > 0 {
			price := int64(100) // Default price: 1.00 cent per unit
			if bp, ok := s.basePrices[pos.ProductID]; ok {
				price = bp
			} else {
				// Fallback: estimate from recipe wage rate + duration + 50% markup
				for _, capStatus := range capacities {
					recipe, ok := ctx.State.Recipe(capStatus.RecipeID)
					if ok && recipe.OutputProductID == pos.ProductID {
						if recipe.OutputQtyCent > 0 {
							// wage_rate es por segundo SIMULADO; DurationSeconds llega
							// en segundos reales, reconvertimos con el factor de simulacion.
							wageCost := int64(float64(recipe.WageRateCentsPerSec*recipe.DurationSeconds) * s.simTimeFactor)
							costPerUnit := wageCost / recipe.OutputQtyCent
							if costPerUnit > 0 {
								price = int64(float64(costPerUnit) * 1.5)
							}
						}
						break
					}
				}
			}

			if price > 0 {
				ctx.Logger.Info("Placing sell order", "product_id", pos.ProductID, "qty_cent", unlistedQty, "price_cents", price)
				acts = append(acts, actions.PlaceOrder{
					ProductID:       pos.ProductID,
					Side:            models.SideSell,
					QtyCent:         unlistedQty,
					LimitPriceCents: price,
					TTLSeconds:      300, // 5 minutes
				})
			}
		}
	}

	return acts
}

func (s *PrimaryProducerStrategy) HandleEvent(ctx *strategy.Context, e events.Event) []actions.Action {
	switch ev := e.(type) {
	case events.OrderExecuted:
		ctx.Logger.Info("Producer order executed", "order_id", ev.OrderID, "product_id", ev.ProductID, "qty", ev.QtyExecutedCent, "price", ev.PriceCents)
	case events.TransformationCompleted:
		ctx.Logger.Info("Producer transformation completed", "process_id", ev.ProcessID, "recipe_id", ev.RecipeID)
	case events.BankruptcyNotice:
		ctx.Logger.Warn("Producer bankruptcy notice received!", "agent_id", ev.AgentID)
	}
	return nil
}
