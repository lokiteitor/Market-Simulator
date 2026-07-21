package main

import (
	"math/rand/v2"
	"sync"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// ProducerStrategy es la ÚNICA estrategia productora (ADR-022): extraer y
// transformar son el mismo acto económico, porque toda receta consume insumos
// salvo la extracción de agua (raíz del catálogo). Antes había dos estrategias
// que se repartían el catálogo por `len(recipe.Inputs)`; ese reparto ya no
// significa nada y habría dejado sin producir a la mitad del enjambre.
//
// Comportamiento:
//   - Oferta elástica: solo arranca una receta si el fair del output cubre
//     insumos + salario con margen mínimo. Si un producto se abarata, la
//     producción para, el inventario se agota y el precio se recupera.
//   - Reposición de insumos: bids de descanso bajo el fair, o cruce del ask
//     cuando el margen de la receta sobrevive pagándolo (así la cadena
//     agua→cultivo→harina→pan ejecuta de verdad en vez de descansar en bids
//     que nadie cruza).
//   - Venta a mercado: undercut del mejor ask con suelo de coste, en tranches,
//     con cancel/replace de asks viejos. NUNCA vende lo que consume.
//   - Patrón oro: si mina oro y la ventanilla del banco paga mejor que el
//     mercado, monetiza ahí.
//
// El reparto del catálogo entre bots lo hace `typeFilter` (tipos de instalación
// que este bot está dispuesto a comprar): aguador, farmer, miner, transformer.
type ProducerStrategy struct {
	mu                sync.Mutex
	rnd               *rand.Rand
	view              *MarketView
	bank              *bankWindow
	basePrices        map[string]int64
	simTimeFactor     float64
	maxRecipesPerTick int
	p                 producerParams
	// typeFilter: keys de installation_type que este bot produce (nil = todas).
	typeFilter map[string]bool
	subscribed []string
	role       models.AgentRole
	// Instalaciones (ADR-021): tope de nivel deseado y colchón de capital para
	// comprar/mejorar sin descapitalizarse; nº máximo de compras por tick.
	maxDesiredLevel      int
	capitalReserveFactor int64
	maxBuysPerTick       int
}

type producerParams struct {
	minMargin     float64 // margen minimo sobre coste: gate de produccion y suelo de venta
	targetMargin  float64 // margen objetivo cuando no hay ask que mejorar
	crossProb     float64 // probabilidad de cruzar el ask por insumos (si el margen aguanta)
	bufferExecs   int     // ejecuciones de buffer de insumos por instalacion
	restingDisc   float64 // descuento del bid de descanso vs fair del insumo
	undercut      float64 // rebaja relativa sobre el mejor ask
	tranche       float64 // fraccion del inventario listada por tick
	requoteThresh float64 // desviacion que dispara cancel/replace
	actProb       float64
	skipTickProb  float64
	liqCap        float64 // techo del suelo relativo al fair (modo liquidacion)
	capitalDen    int64   // presupuesto por insumo = capital / capitalDen
	restBudget    int
}

func NewProducerStrategy() *ProducerStrategy {
	return &ProducerStrategy{
		basePrices:           make(map[string]int64),
		simTimeFactor:        5,
		maxRecipesPerTick:    8,
		maxDesiredLevel:      3,
		capitalReserveFactor: 3,
		maxBuysPerTick:       1,
	}
}

// producibleRecipes: recetas cuyo tipo de instalación corresponde al rol del bot
// y pasa el typeFilter. Base para producción y para decidir qué comprar.
func (s *ProducerStrategy) producibleRecipes(ctx *strategy.Context) []models.Recipe {
	out := make([]models.Recipe, 0, 32)
	for _, recipe := range ctx.State.CatalogRecipes() {
		typ, ok := ctx.State.InstallationTypeByID(recipe.InstallationTypeID)
		if !ok || models.AgentRole(typ.Role) != s.role {
			continue
		}
		if s.typeFilter != nil && !s.typeFilter[typ.Key] {
			continue
		}
		out = append(out, recipe)
	}
	return out
}

func (s *ProducerStrategy) Initialize(ctx *strategy.Context) error {
	ctx.Logger.Info("ProducerStrategy initializing...")
	s.rnd = newStrategyRand(ctx)
	_, _, s.role, _ = ctx.State.GetAgentInfo()
	s.basePrices = resolveBasePrices(ctx)
	s.view = newMarketView(ctx, s.basePrices)
	s.bank = loadBankWindow(ctx)
	s.simTimeFactor = configFloat(ctx.Config, "sim_time_factor", s.simTimeFactor)
	s.maxRecipesPerTick = configInt(ctx.Config, "max_recipes_per_tick", s.maxRecipesPerTick)
	s.p = producerParams{
		minMargin:     sampleRange(s.rnd, 0.05, 0.2),
		targetMargin:  sampleRange(s.rnd, 0.2, 0.5),
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
	// Suscripción de tape (fan-out selectivo): insumos y outputs de sus recetas
	// —todo lo que compra y todo lo que vende—, más el oro si hay ventanilla (su
	// precio de mercado decide vender al banco o al libro).
	seen := make(map[string]bool)
	for _, recipe := range s.producibleRecipes(ctx) {
		for _, input := range recipe.Inputs {
			seen[input.ProductID] = true
		}
		seen[recipe.OutputProductID] = true
	}
	if s.bank.enabled {
		seen[s.bank.goldProductID] = true
	}
	s.subscribed = make([]string, 0, len(seen))
	for id := range seen {
		s.subscribed = append(s.subscribed, id)
	}
	ctx.Logger.Info("ProducerStrategy initialized",
		"priced_products", len(s.basePrices),
		"tape_products", len(s.subscribed),
		"sim_time_factor", s.simTimeFactor,
		"max_recipes_per_tick", s.maxRecipesPerTick,
		"target_margin", s.p.targetMargin,
	)
	return nil
}

// wagePerExecCents es el salario por ejecucion en cents (el servidor cobra
// por segundos SIMULADOS; DurationSeconds llega en reales).
func (s *ProducerStrategy) wagePerExecCents(recipe models.Recipe) int64 {
	return int64(float64(recipe.WageRateCentsPerSec*recipe.DurationSeconds) * s.simTimeFactor)
}

// outputFair devuelve el fair del output con el suelo de la ventanilla del
// banco para el oro: el banco garantiza window_bid, así que el precio efectivo
// nunca es menor (aunque el mercado libre esté deprimido, minar y monetizar
// sigue rentando).
func (s *ProducerStrategy) outputFair(productID string) (int64, bool) {
	fair, has := s.view.Fair(productID)
	if s.bank.enabled && productID == s.bank.goldProductID && (!has || fair < s.bank.windowBid) {
		return s.bank.windowBid, true
	}
	return fair, has
}

// execEconomics valora una ejecucion de la receta a precios fair: coste de
// insumos, salario e ingreso del output. ok=false si falta el fair de alguna
// pata (sin valoracion no hay decision). Con `inputs: []` (la raíz del
// catálogo) inputsCost es 0 y el coste es puro salario.
func (s *ProducerStrategy) execEconomics(recipe models.Recipe) (inputsCost, wage, revenue int64, ok bool) {
	for _, input := range recipe.Inputs {
		fairIn, has := s.view.Fair(input.ProductID)
		if !has {
			return 0, 0, 0, false
		}
		inputsCost += notionalCents(input.QtyRequiredCent, fairIn)
	}
	fairOut, has := s.outputFair(recipe.OutputProductID)
	if !has {
		return 0, 0, 0, false
	}
	wage = s.wagePerExecCents(recipe)
	revenue = notionalCents(recipe.OutputQtyCent, fairOut)
	return inputsCost, wage, revenue, true
}

func (s *ProducerStrategy) Tick(ctx *strategy.Context) []actions.Action {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, _, _, status := ctx.State.GetAgentInfo(); status == models.StatusBankrupt {
		return nil
	}
	if chance(s.rnd, s.p.skipTickProb) {
		return nil
	}
	s.view.BeginTick(s.p.restBudget)

	producible := s.producibleRecipes(ctx)
	activeOrders := ctx.State.ActiveOrders()
	capitalAvail, _ := ctx.State.Capital()

	activeBuyQty := make(map[string]int64)
	for _, order := range activeOrders {
		if order.Side == models.SideBuy {
			activeBuyQty[order.ProductID] += order.QtyPendingCent
		}
	}

	var acts []actions.Action
	// Solo se vende lo que producimos con instalaciones PROPIAS, y solo por
	// encima del buffer que consumimos: un aguador vende agua, pero el
	// agricultor que la compra para regar, no; y el que produce sus propias
	// semillas vende el excedente, no la simiente del año que viene. Sin esto el
	// bot se remata sus propios insumos y se queda sin poder producir.
	recipeByOutput := make(map[string]models.Recipe)
	reservado := make(map[string]int64)
	handledInputs := make(map[string]bool) // varias recetas comparten insumos
	recipesActed := 0
	buysActed := 0
	// Los slots son un presupuesto compartido por tipo (ADR-021) y el estado
	// local no se actualiza hasta que el engine ejecuta las acciones: sin
	// descontar lo comprometido en este mismo tick, dos recetas del mismo tipo
	// verían libre el mismo hueco y la segunda moriría con 422
	// recipe_capacity_saturated. Ídem para compras duplicadas del mismo tipo
	// (chocarían en expected_current_level).
	slotsCommitted := make(map[string]int)
	typesBought := make(map[string]bool)
	for _, recipe := range producible {
		inst, _, owned, typeKnown := installationForRecipe(ctx, recipe)
		if !typeKnown || !owned {
			continue // solo lo que este bot produce de verdad
		}
		recipeByOutput[recipe.OutputProductID] = recipe
		buffLevel := max(inst.Level, 1)
		for _, input := range recipe.Inputs {
			target := input.QtyRequiredCent * int64(buffLevel) * int64(s.p.bufferExecs)
			if target > reservado[input.ProductID] {
				reservado[input.ProductID] = target
			}
		}
	}
	// Orden aleatorio: con el cap por tick, un orden fijo mataria de hambre a
	// las recetas del final de la lista.
	for _, idx := range s.rnd.Perm(len(producible)) {
		recipe := producible[idx]
		if s.maxRecipesPerTick > 0 && recipesActed >= s.maxRecipesPerTick {
			continue
		}
		if !chance(s.rnd, s.p.actProb) {
			continue
		}
		recipesActed++

		inst, typ, owned, typeKnown := installationForRecipe(ctx, recipe)
		if !typeKnown {
			continue
		}
		inst.AvailableSlots -= slotsCommitted[typ.Key]
		if inst.AvailableSlots < 0 {
			inst.AvailableSlots = 0
		}

		inputsCost, wage, revenue, priced := s.execEconomics(recipe)
		profitable := priced && float64(revenue) >= float64(inputsCost+wage)*(1+s.p.minMargin)

		if !profitable && priced {
			// Si no es rentable a precio estimado de mercado, comprobamos si de verdad hay
			// competencia barata (un ask en el mercado por debajo de nuestro coste + margen).
			// Si no hay asks o el mejor ask es caro, consideramos que la receta es viable para producir.
			floor := float64(inputsCost+wage) * (1 + s.p.minMargin)
			topOut := s.view.Top(ctx, recipe.OutputProductID)
			if topOut == nil || topOut.BestAsk == nil || float64(notionalCents(recipe.OutputQtyCent, topOut.BestAsk.PriceCents)) >= floor {
				profitable = true
			}
		}

		// A0. Comprar/mejorar la instalación del tipo si la receta es rentable
		// pero la producción está bloqueada por falta de huecos (ADR-021).
		if profitable && (!owned || inst.AvailableSlots <= 0) &&
			!typesBought[typ.Key] && buysActed < s.maxBuysPerTick {
			if buy, ok := installationBuyAction(inst, typ, owned, capitalAvail,
				s.maxDesiredLevel, s.capitalReserveFactor); ok {
				acts = append(acts, buy)
				buysActed++
				typesBought[typ.Key] = true
				// El capital/estado reales se rebasearán en el próximo snapshot;
				// no seguimos produciendo con esta receta este tick.
				continue
			}
		}

		// A. Arrancar ejecuciones solo si son rentables a precios de mercado y hay capital para salarios.
		if profitable && owned && inst.AvailableSlots > 0 {
			maxExecutions := inst.AvailableSlots
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
				// No siempre a plena capacidad: los operadores humanos dosifican.
				execs := maxExecutions
				if execs > 1 && chance(s.rnd, 0.5) {
					execs = 1 + s.rnd.IntN(execs)
				}
				acts = append(acts, actions.StartTransformation{
					RecipeID:          recipe.RecipeID,
					ExecutionsPlanned: execs,
				})
				capitalAvail -= wage * int64(execs)
				slotsCommitted[typ.Key] += execs
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
			buffLevel := inst.Level
			if buffLevel < 1 {
				buffLevel = 1
			}
			targetQty := input.QtyRequiredCent * int64(buffLevel) * int64(s.p.bufferExecs)
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
		// Oro minado: si la ventanilla del banco paga mejor que el mercado, se
		// monetiza ahí (dinero acuñado) en vez de listar asks. goldArbActions
		// con budget 0 solo ejecuta esa pata (no arriesga capital).
		if s.bank.enabled && pos.ProductID == s.bank.goldProductID {
			if arb := goldArbActions(ctx, s.rnd, s.view, s.bank, s.p.minMargin, 0); len(arb) > 0 {
				acts = append(acts, arb...)
				continue
			}
		}
		recipe, isOutput := recipeByOutput[pos.ProductID]
		if !isOutput {
			continue // no vender materias primas compradas como insumo
		}
		if !chance(s.rnd, s.p.actProb) {
			continue
		}
		// Excedente sobre el buffer que nosotros mismos consumimos.
		pos.QtyAvailableCent -= reservado[pos.ProductID]
		if pos.QtyAvailableCent <= 0 {
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

// SubscribedProducts implementa strategy.ProductSubscriber: el engine
// suscribe el WS solo al tape de estos productos.
func (s *ProducerStrategy) SubscribedProducts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.subscribed...)
}

func (s *ProducerStrategy) HandleEvent(ctx *strategy.Context, e events.Event) []actions.Action {
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
