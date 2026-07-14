package main

import (
	"math/rand/v2"
	"sync"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// TransformerStrategy ejecuta recetas con insumos, decidiendo a PRECIOS DE
// MERCADO: solo arranca una receta si el fair del output cubre insumos+salario
// con margen, compra insumos cruzando el spread cuando el margen sobrevive al
// ask (eso imprime trades reales en la cadena trigo->harina->pan), y vende
// outputs con undercut y suelo de coste como el productor.
type TransformerStrategy struct {
	mu                sync.Mutex
	rnd               *rand.Rand
	view              *MarketView
	basePrices        map[string]int64
	simTimeFactor     float64
	maxRecipesPerTick int
	p                 transformerParams
}

type transformerParams struct {
	minMargin     float64 // margen minimo sobre coste total por ejecucion
	targetMargin  float64
	crossProb     float64 // probabilidad de cruzar el ask por insumos (si el margen aguanta)
	bufferExecs   int     // ejecuciones de buffer de insumos por instalacion
	restingDisc   float64 // descuento del bid de descanso vs fair del insumo
	undercut      float64
	tranche       float64
	requoteThresh float64
	actProb       float64
	skipTickProb  float64
	liqCap        float64
	capitalDen    int64 // presupuesto por insumo = capital / capitalDen
	restBudget    int
}

func NewTransformerStrategy() *TransformerStrategy {
	return &TransformerStrategy{
		basePrices:        make(map[string]int64),
		simTimeFactor:     5,
		maxRecipesPerTick: 8,
	}
}

func (s *TransformerStrategy) Initialize(ctx *strategy.Context) error {
	ctx.Logger.Info("TransformerStrategy initializing...")
	s.rnd = newStrategyRand(ctx)
	s.basePrices = resolveBasePrices(ctx)
	s.view = newMarketView(ctx, s.basePrices)
	s.simTimeFactor = configFloat(ctx.Config, "sim_time_factor", s.simTimeFactor)
	s.maxRecipesPerTick = configInt(ctx.Config, "max_recipes_per_tick", s.maxRecipesPerTick)
	s.p = transformerParams{
		minMargin:     sampleRange(s.rnd, 0.05, 0.2),
		targetMargin:  sampleRange(s.rnd, 0.2, 0.45),
		crossProb:     sampleRange(s.rnd, 0.3, 0.7),
		bufferExecs:   sampleIntRange(s.rnd, 3, 6),
		restingDisc:   sampleRange(s.rnd, 0.02, 0.06),
		undercut:      sampleRange(s.rnd, 0.01, 0.03),
		tranche:       sampleRange(s.rnd, 0.3, 0.7),
		requoteThresh: sampleRange(s.rnd, 0.02, 0.05),
		actProb:       sampleRange(s.rnd, 0.75, 1.0),
		skipTickProb:  sampleRange(s.rnd, 0.05, 0.2),
		liqCap:        sampleRange(s.rnd, 1.2, 1.5),
		capitalDen:    int64(sampleIntRange(s.rnd, 3, 6)),
		restBudget:    int(marketCfgFloat(ctx.Config, "rest_budget_per_tick", 4)),
	}
	ctx.Logger.Info("TransformerStrategy initialized",
		"priced_products", len(s.basePrices),
		"sim_time_factor", s.simTimeFactor,
		"max_recipes_per_tick", s.maxRecipesPerTick,
		"cross_prob", s.p.crossProb,
	)
	return nil
}

// wagePerExecCents es el salario por ejecucion en cents (el servidor cobra
// por segundos SIMULADOS; DurationSeconds llega en reales).
func (s *TransformerStrategy) wagePerExecCents(recipe models.Recipe) int64 {
	return int64(float64(recipe.WageRateCentsPerSec*recipe.DurationSeconds) * s.simTimeFactor)
}

// execEconomics valora una ejecucion de la receta a precios fair: coste de
// insumos, salario e ingreso del output. ok=false si falta el fair de alguna
// pata (sin valoracion no hay decision).
func (s *TransformerStrategy) execEconomics(recipe models.Recipe) (inputsCost, wage, revenue int64, ok bool) {
	for _, input := range recipe.Inputs {
		fairIn, has := s.view.Fair(input.ProductID)
		if !has {
			return 0, 0, 0, false
		}
		inputsCost += notionalCents(input.QtyRequiredCent, fairIn)
	}
	fairOut, has := s.view.Fair(recipe.OutputProductID)
	if !has {
		return 0, 0, 0, false
	}
	wage = s.wagePerExecCents(recipe)
	revenue = notionalCents(recipe.OutputQtyCent, fairOut)
	return inputsCost, wage, revenue, true
}

func (s *TransformerStrategy) Tick(ctx *strategy.Context) []actions.Action {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, _, _, status := ctx.State.GetAgentInfo(); status == models.StatusBankrupt {
		return nil
	}
	if chance(s.rnd, s.p.skipTickProb) {
		return nil
	}
	s.view.BeginTick(s.p.restBudget)

	capacities := ctx.State.Capacities()
	activeOrders := ctx.State.ActiveOrders()
	capitalAvail, _ := ctx.State.Capital()

	activeBuyQty := make(map[string]int64)
	for _, order := range activeOrders {
		if order.Side == models.SideBuy {
			activeBuyQty[order.ProductID] += order.QtyPendingCent
		}
	}

	var acts []actions.Action
	recipeByOutput := make(map[string]models.Recipe)
	handledInputs := make(map[string]bool) // varias recetas comparten insumos
	recipesActed := 0
	// Orden aleatorio: con el cap por tick, un orden fijo mataria de hambre a
	// las recetas del final de la lista.
	for _, idx := range s.rnd.Perm(len(capacities)) {
		capStatus := capacities[idx]
		recipe, ok := ctx.State.Recipe(capStatus.RecipeID)
		if !ok || len(recipe.Inputs) == 0 {
			continue // las recetas sin insumos son de los productores
		}
		recipeByOutput[recipe.OutputProductID] = recipe
		if s.maxRecipesPerTick > 0 && recipesActed >= s.maxRecipesPerTick {
			continue
		}
		if !chance(s.rnd, s.p.actProb) {
			continue
		}
		recipesActed++

		inputsCost, wage, revenue, priced := s.execEconomics(recipe)
		profitable := priced && float64(revenue) >= float64(inputsCost+wage)*(1+s.p.minMargin)

		if !profitable && priced {
			// Si no es rentable a precio estimado de mercado, comprobamos si de verdad hay
			// competencia barata (un ask en el mercado por debajo de nuestro coste + margen).
			// Si no hay asks o el mejor ask es caro, consideramos que la receta es viable para producir.
			floor := float64(inputsCost+wage)*(1+s.p.minMargin)
			topOut := s.view.Top(ctx, recipe.OutputProductID)
			if topOut == nil || topOut.BestAsk == nil || float64(notionalCents(recipe.OutputQtyCent, topOut.BestAsk.PriceCents)) >= floor {
				profitable = true
			}
		}

		// A. Arrancar ejecuciones solo si son rentables a precios de mercado y hay capital para salarios.
		if profitable && capStatus.AvailableSlots > 0 {
			maxExecutions := capStatus.AvailableSlots
			for _, input := range recipe.Inputs {
				inv := ctx.State.InventoryForProduct(input.ProductID)
				possible := int(inv.QtyAvailableCent / input.QtyRequiredCent)
				if possible < maxExecutions {
					maxExecutions = possible
				}
			}
			// Limitar ejecuciones segun capital disponible para salarios upfront
			if wage > 0 {
				maxExecsByCapital := int(capitalAvail / wage)
				if maxExecsByCapital < maxExecutions {
					maxExecutions = maxExecsByCapital
				}
			}
			if maxExecutions > 0 {
				execs := maxExecutions
				if execs > 1 && chance(s.rnd, 0.5) {
					execs = 1 + s.rnd.IntN(execs)
				}
				acts = append(acts, actions.StartTransformation{
					RecipeID:          recipe.RecipeID,
					ExecutionsPlanned: execs,
				})
				capitalAvail -= wage * int64(execs)
			}
		} else if priced && !profitable {
			ctx.Logger.Debug("receta pausada: sin margen a precios de mercado",
				"recipe_id", recipe.RecipeID, "revenue", revenue, "cost", inputsCost+wage)
		}

		// B. Reponer insumos solo para recetas rentables (comprar inputs de
		// una receta sin margen es quemar capital).
		if !profitable {
			continue
		}
		for _, input := range recipe.Inputs {
			// Un solo tratamiento por insumo y tick: si dos recetas comparten
			// insumo, repetirlo duplicaria cancelaciones y recontaria buffers.
			if handledInputs[input.ProductID] {
				continue
			}
			handledInputs[input.ProductID] = true
			inv := ctx.State.InventoryForProduct(input.ProductID)
			targetQty := input.QtyRequiredCent * int64(capStatus.Installations) * int64(s.p.bufferExecs)
			currentQty := inv.QtyAvailableCent + activeBuyQty[input.ProductID]
			if currentQty >= targetQty {
				continue
			}
			fairIn, has := s.view.Fair(input.ProductID)
			if !has {
				continue
			}

			// Precio: descanso bajo el fair, o cruce del ask si el margen de
			// la receta sobrevive pagandolo (asi la cadena de insumos ejecuta
			// de verdad en vez de descansar en bids que nadie cruza).
			price := int64(float64(fairIn) * (1 - s.p.restingDisc))
			if top := s.view.Top(ctx, input.ProductID); top != nil && top.BestAsk != nil && chance(s.rnd, s.p.crossProb) {
				askExtra := notionalCents(input.QtyRequiredCent, top.BestAsk.PriceCents) -
					notionalCents(input.QtyRequiredCent, fairIn)
				if float64(revenue) >= float64(inputsCost+askExtra+wage)*(1+s.p.minMargin) {
					price = top.BestAsk.PriceCents
				}
			}
			price = nicePrice(s.rnd, price)
			if price < 1 {
				continue
			}

			cancels, liveBuy, _ := cancelStale(activeOrders, input.ProductID, models.SideBuy, price, s.p.requoteThresh)
			acts = append(acts, cancels...)
			qtyToBuy := targetQty - (inv.QtyAvailableCent + liveBuy)
			if qtyToBuy <= 0 {
				continue
			}
			qtyToBuy = humanQty(s.rnd, qtyToBuy)
			budget := capitalAvail / s.p.capitalDen
			if maxQty := maxQtyForBudget(budget, price); qtyToBuy > maxQty {
				qtyToBuy = maxQty
			}
			if isReservable(qtyToBuy, price) {
				acts = append(acts, actions.PlaceOrder{
					ProductID:       input.ProductID,
					Side:            models.SideBuy,
					QtyCent:         qtyToBuy,
					LimitPriceCents: price,
					TTLSeconds:      ttlJitter(s.rnd),
				})
				capitalAvail -= notionalCents(qtyToBuy, price)
				activeBuyQty[input.ProductID] += qtyToBuy
			}
		}
	}

	// C. Vender los outputs producidos a precio de mercado con suelo de coste.
	for _, pos := range ctx.State.Inventory() {
		recipe, isOutput := recipeByOutput[pos.ProductID]
		if !isOutput {
			continue // no vender materias primas compradas como insumo
		}
		if !chance(s.rnd, s.p.actProb) {
			continue
		}
		var costPU int64
		if inputsCost, wage, _, priced := s.execEconomics(recipe); priced && recipe.OutputQtyCent > 0 {
			costPU = (inputsCost + wage) * 100 / recipe.OutputQtyCent
		}
		acts = append(acts, sellAtMarket(ctx, s.rnd, s.view, pos, costPU, sellParams{
			minMargin:     s.p.minMargin,
			targetMargin:  s.p.targetMargin,
			undercut:      s.p.undercut,
			tranche:       s.p.tranche,
			requoteThresh: s.p.requoteThresh,
			liqCap:        s.p.liqCap,
		})...)
	}

	return acts
}

func (s *TransformerStrategy) HandleEvent(ctx *strategy.Context, e events.Event) []actions.Action {
	switch ev := e.(type) {
	case events.TradePrinted:
		s.mu.Lock()
		s.view.OnTrade(ev)
		s.mu.Unlock()
	case events.OrderExecuted:
		ctx.Logger.Debug("Transformer order executed", "order_id", ev.OrderID, "product_id", ev.ProductID, "qty", ev.QtyExecutedCent, "price", ev.PriceCents)
	case events.TransformationCompleted:
		ctx.Logger.Debug("Transformer transformation completed", "process_id", ev.ProcessID, "recipe_id", ev.RecipeID)
	case events.BankruptcyNotice:
		ctx.Logger.Warn("Transformer bankruptcy notice received!", "agent_id", ev.AgentID)
	}
	return nil
}
