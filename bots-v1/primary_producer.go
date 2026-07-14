package main

import (
	"math/rand/v2"
	"sync"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// PrimaryProducerStrategy ejecuta recetas sin insumos y vende lo producido.
// Dos comportamientos de mercado real:
//   - Oferta elastica: solo produce cuando el valor justo cubre el coste
//     salarial con margen minimo. Si un producto se abarata, los productores
//     paran, el inventario se agota y el precio se recupera.
//   - Venta a mercado: undercut del mejor ask con suelo de coste, en tranches
//     en vez de volcar todo el inventario, con cancel/replace de asks viejos.
type PrimaryProducerStrategy struct {
	mu                sync.Mutex
	rnd               *rand.Rand
	view              *MarketView
	bank              *bankWindow
	basePrices        map[string]int64
	simTimeFactor     float64
	maxRecipesPerTick int
	p                 producerParams
	recipeFilter      func(recipeID string) bool
}

type producerParams struct {
	minMargin     float64 // margen minimo sobre coste: gate de produccion y suelo de venta
	targetMargin  float64 // margen objetivo cuando no hay ask que mejorar
	undercut      float64 // rebaja relativa sobre el mejor ask
	tranche       float64 // fraccion del inventario listada por tick
	requoteThresh float64 // desviacion que dispara cancel/replace
	actProb       float64
	skipTickProb  float64
	liqCap        float64 // techo del suelo relativo al fair (modo liquidacion)
	restBudget    int
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
	s.rnd = newStrategyRand(ctx)
	s.basePrices = resolveBasePrices(ctx)
	s.view = newMarketView(ctx, s.basePrices)
	s.bank = loadBankWindow(ctx)
	s.simTimeFactor = configFloat(ctx.Config, "sim_time_factor", s.simTimeFactor)
	s.maxRecipesPerTick = configInt(ctx.Config, "max_recipes_per_tick", s.maxRecipesPerTick)
	s.p = producerParams{
		minMargin:     sampleRange(s.rnd, 0.05, 0.15),
		targetMargin:  sampleRange(s.rnd, 0.25, 0.6),
		undercut:      sampleRange(s.rnd, 0.01, 0.03),
		tranche:       sampleRange(s.rnd, 0.3, 0.7),
		requoteThresh: sampleRange(s.rnd, 0.02, 0.05),
		actProb:       sampleRange(s.rnd, 0.75, 1.0),
		skipTickProb:  sampleRange(s.rnd, 0.05, 0.2),
		liqCap:        sampleRange(s.rnd, 1.2, 1.5),
		restBudget:    int(marketCfgFloat(ctx.Config, "rest_budget_per_tick", 4)),
	}
	ctx.Logger.Info("PrimaryProducerStrategy initialized",
		"priced_products", len(s.basePrices),
		"sim_time_factor", s.simTimeFactor,
		"max_recipes_per_tick", s.maxRecipesPerTick,
		"target_margin", s.p.targetMargin,
	)
	return nil
}

// unitCostCents estima el coste salarial por UNIDAD (cents/unidad) de una
// receta: el servidor cobra wage_rate * segundos SIMULADOS por ejecucion, y
// el output viene en cent-units (100 = 1 unidad).
func (s *PrimaryProducerStrategy) unitCostCents(recipe models.Recipe) int64 {
	if recipe.OutputQtyCent <= 0 {
		return 0
	}
	wagePerExec := float64(recipe.WageRateCentsPerSec*recipe.DurationSeconds) * s.simTimeFactor
	return int64(wagePerExec*100/float64(recipe.OutputQtyCent) + 0.5)
}

func (s *PrimaryProducerStrategy) Tick(ctx *strategy.Context) []actions.Action {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, _, _, status := ctx.State.GetAgentInfo(); status == models.StatusBankrupt {
		return nil
	}
	if chance(s.rnd, s.p.skipTickProb) {
		return nil
	}
	s.view.BeginTick(s.p.restBudget)

	var acts []actions.Action
	capacities := ctx.State.Capacities()

	// 1. Produccion condicionada a margen (oferta elastica). Orden aleatorio:
	// con el cap por tick, un orden fijo mataria de hambre a las recetas del
	// final de la lista.
	recipesActed := 0
	recipeByOutput := make(map[string]models.Recipe)
	for _, idx := range s.rnd.Perm(len(capacities)) {
		capStatus := capacities[idx]
		recipe, ok := ctx.State.Recipe(capStatus.RecipeID)
		if !ok || len(recipe.Inputs) != 0 {
			continue
		}
		if s.recipeFilter != nil && !s.recipeFilter(recipe.RecipeID) {
			continue
		}
		recipeByOutput[recipe.OutputProductID] = recipe
		if capStatus.AvailableSlots <= 0 {
			continue
		}
		if s.maxRecipesPerTick > 0 && recipesActed >= s.maxRecipesPerTick {
			continue
		}
		if !chance(s.rnd, s.p.actProb) {
			continue
		}
		costPU := s.unitCostCents(recipe)
		fair, hasFair := s.view.Fair(recipe.OutputProductID)
		// Patrón oro: la ventanilla del banco garantiza window_bid por el oro,
		// así que el precio efectivo para el gate de producción nunca es menor
		// (aunque el mercado libre esté deprimido, minar y monetizar renta).
		if s.bank.enabled && recipe.OutputProductID == s.bank.goldProductID &&
			(!hasFair || fair < s.bank.windowBid) {
			fair, hasFair = s.bank.windowBid, true
		}
		if hasFair && costPU > 0 && float64(fair) < float64(costPU)*(1+s.p.minMargin) {
			// Si no hay competencia barata en el mercado (sin asks o el mejor ask es caro),
			// no pausamos la producción para poder abastecer al mercado.
			floor := float64(costPU) * (1 + s.p.minMargin)
			top := s.view.Top(ctx, recipe.OutputProductID)
			if top != nil && top.BestAsk != nil && float64(top.BestAsk.PriceCents) < floor {
				ctx.Logger.Debug("produccion pausada: fair no cubre coste+margen y hay competencia barata",
					"recipe_id", recipe.RecipeID, "fair", fair, "unit_cost", costPU, "best_ask", top.BestAsk.PriceCents)
				continue
			}
		}
		recipesActed++
		// No siempre a plena capacidad: los operadores humanos dosifican.
		execs := capStatus.AvailableSlots
		if execs > 1 && chance(s.rnd, 0.5) {
			execs = 1 + s.rnd.IntN(execs)
		}
		acts = append(acts, actions.StartTransformation{
			RecipeID:          recipe.RecipeID,
			ExecutionsPlanned: execs,
		})
	}

	// 2. Venta del inventario a precio de mercado con suelo de coste.
	for _, pos := range ctx.State.Inventory() {
		if !chance(s.rnd, s.p.actProb) {
			continue
		}
		// Oro minado: si la ventanilla del banco paga mejor que el mercado, se
		// monetiza ahí (dinero acuñado) en vez de listar asks. goldArbActions
		// con budget 0 solo ejecuta esa pata (no arriesga capital).
		if s.bank.enabled && pos.ProductID == s.bank.goldProductID {
			if arb := goldArbActions(ctx, s.rnd, s.view, s.bank, s.p.minMargin, 0); len(arb) > 0 {
				acts = append(acts, arb...)
				continue
			}
		}
		recipe, isOwnOutput := recipeByOutput[pos.ProductID]
		var costPU int64
		if isOwnOutput {
			costPU = s.unitCostCents(recipe)
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

func (s *PrimaryProducerStrategy) HandleEvent(ctx *strategy.Context, e events.Event) []actions.Action {
	switch ev := e.(type) {
	case events.TradePrinted:
		s.mu.Lock()
		s.view.OnTrade(ev)
		s.mu.Unlock()
	case events.OrderExecuted:
		ctx.Logger.Debug("Producer order executed", "order_id", ev.OrderID, "product_id", ev.ProductID, "qty", ev.QtyExecutedCent, "price", ev.PriceCents)
	case events.TransformationCompleted:
		ctx.Logger.Debug("Producer transformation completed", "process_id", ev.ProcessID, "recipe_id", ev.RecipeID)
	case events.BankruptcyNotice:
		ctx.Logger.Warn("Producer bankruptcy notice received!", "agent_id", ev.AgentID)
	}
	return nil
}
