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
	subscribed        []string
	role              models.AgentRole
	// Instalaciones (ADR-021): tope de nivel deseado y colchón de capital para
	// comprar/mejorar sin descapitalizarse; nº máximo de compras por tick.
	maxDesiredLevel      int
	capitalReserveFactor int64
	maxBuysPerTick       int
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
		basePrices:           make(map[string]int64),
		simTimeFactor:        5,
		maxRecipesPerTick:    8,
		maxDesiredLevel:      4,
		capitalReserveFactor: 3,
		maxBuysPerTick:       1,
	}
}

// producibleRecipes: recetas primarias (sin insumos) cuyo tipo de instalación
// corresponde al rol del bot y pasan el recipeFilter. Base para producción y
// para decidir qué instalación comprar.
func (s *PrimaryProducerStrategy) producibleRecipes(ctx *strategy.Context) []models.Recipe {
	out := make([]models.Recipe, 0, 16)
	for _, recipe := range ctx.State.CatalogRecipes() {
		if len(recipe.Inputs) != 0 {
			continue
		}
		if s.recipeFilter != nil && !s.recipeFilter(recipe.RecipeID) {
			continue
		}
		typ, ok := ctx.State.InstallationTypeByID(recipe.InstallationTypeID)
		if !ok || models.AgentRole(typ.Role) != s.role {
			continue
		}
		out = append(out, recipe)
	}
	return out
}

func (s *PrimaryProducerStrategy) Initialize(ctx *strategy.Context) error {
	ctx.Logger.Info("PrimaryProducerStrategy initializing...")
	s.rnd = newStrategyRand(ctx)
	_, _, s.role, _ = ctx.State.GetAgentInfo()
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
	// Suscripción de tape (fan-out selectivo): solo los outputs de las
	// recetas primarias que este bot puede ejecutar, más el oro si hay
	// ventanilla (su precio de mercado decide vender al banco o al libro).
	seen := make(map[string]bool)
	for _, recipe := range s.producibleRecipes(ctx) {
		seen[recipe.OutputProductID] = true
	}
	if s.bank.enabled {
		seen[s.bank.goldProductID] = true
	}
	s.subscribed = make([]string, 0, len(seen))
	for id := range seen {
		s.subscribed = append(s.subscribed, id)
	}
	ctx.Logger.Info("PrimaryProducerStrategy initialized",
		"priced_products", len(s.basePrices),
		"tape_products", len(s.subscribed),
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

	capitalAvail, _ := ctx.State.Capital()

	var acts []actions.Action
	producible := s.producibleRecipes(ctx)

	// 1. Produccion condicionada a margen (oferta elastica). Orden aleatorio:
	// con el cap por tick, un orden fijo mataria de hambre a las recetas del
	// final de la lista. Si una receta es rentable pero no hay instalación
	// (o está saturada), se COMPRA/MEJORA la instalación del tipo (ADR-021).
	recipesActed := 0
	buysActed := 0
	recipeByOutput := make(map[string]models.Recipe)
	for _, idx := range s.rnd.Perm(len(producible)) {
		recipe := producible[idx]
		recipeByOutput[recipe.OutputProductID] = recipe
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
		profitable := true
		if hasFair && costPU > 0 && float64(fair) < float64(costPU)*(1+s.p.minMargin) {
			// Si no hay competencia barata en el mercado (sin asks o el mejor ask es caro),
			// no pausamos la producción para poder abastecer al mercado.
			floor := float64(costPU) * (1 + s.p.minMargin)
			top := s.view.Top(ctx, recipe.OutputProductID)
			if top != nil && top.BestAsk != nil && float64(top.BestAsk.PriceCents) < floor {
				profitable = false
			}
		}

		inst, typ, owned, typeKnown := installationForRecipe(ctx, recipe)
		if !typeKnown {
			continue
		}

		// Si es rentable pero la producción está bloqueada por instalación
		// (no comprada o sin huecos), comprar/mejorar si hay capital de sobra.
		if profitable && (!owned || inst.AvailableSlots <= 0) &&
			buysActed < s.maxBuysPerTick {
			if buy, ok := installationBuyAction(inst, typ, owned, capitalAvail,
				s.maxDesiredLevel, s.capitalReserveFactor); ok {
				acts = append(acts, buy)
				buysActed++
				// El capital/estado reales se rebasearán en el próximo snapshot;
				// no seguimos produciendo con esta receta este tick.
				continue
			}
		}

		if !owned || inst.AvailableSlots <= 0 || !profitable {
			continue
		}

		recipesActed++
		wage := int64(float64(recipe.WageRateCentsPerSec*recipe.DurationSeconds) * s.simTimeFactor)

		// No siempre a plena capacidad: los operadores humanos dosifican.
		execs := inst.AvailableSlots
		if wage > 0 {
			maxExecsByCapital := int(capitalAvail / wage)
			if maxExecsByCapital < execs {
				execs = maxExecsByCapital
			}
		}

		if execs > 0 {
			if execs > 1 && chance(s.rnd, 0.5) {
				execs = 1 + s.rnd.IntN(execs)
			}
			acts = append(acts, actions.StartTransformation{
				RecipeID:          recipe.RecipeID,
				ExecutionsPlanned: execs,
			})
			capitalAvail -= wage * int64(execs)
		}
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

// SubscribedProducts implementa strategy.ProductSubscriber: el engine
// suscribe el WS solo al tape de estos productos.
func (s *PrimaryProducerStrategy) SubscribedProducts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.subscribed...)
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
