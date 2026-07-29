package main

import (
	"math/rand/v2"
	"sort"
	"sync"
	"time"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// ProducerStrategy: el motor productor de bots-v2.
//
// Es el de bots-v1 (misma economía por ejecución, mismo gate de margen, misma
// reposición de insumos, mismo suelo de venta) con cuatro diferencias, todas
// consecuencia de que aquí la especialización es el OFICIO y no el tipo de
// instalación:
//
//  1. El universo de recetas lo fija el oficio, receta a receta. En v1 lo fijaba
//     `typeFilter` y dentro de un tipo el bot cubría lo que el `rnd.Perm` de
//     cada tick quisiera.
//  2. El apagado puede ser por COSTE VARIABLE en vez de coste+margen, y el
//     freno por ALMACÉN en vez de por precio. Con esos dos campos, el
//     hidroeléctrico deja de necesitar un binario propio (`bots-hidro`).
//  3. Los parámetros ya no son fijos de por vida: el margen y el undercut se
//     ADAPTAN según se venda o se acumule el stock (ver `adaptar`).
//  4. Si el nicho no da de comer, el bot PIVOTA a otro oficio de una
//     instalación que ya tiene pagada, en vez de esperar sentado a la quiebra.
type ProducerStrategy struct {
	mu                sync.Mutex
	rnd               *rand.Rand
	view              *MarketView
	bank              *bankWindow
	basePrices        map[string]int64
	simTimeFactor     float64
	maxRecipesPerTick int
	p                 producerParams

	// Oficio actual y catálogo completo (para el pivote).
	oficio   Oficio
	catalogo *CatalogoOficios
	// Recetas del oficio ya resueltas contra el catálogo del servidor.
	recetas    []models.Recipe
	subscribed []string
	agentID    string
	role       models.AgentRole

	// Instalaciones (ADR-021).
	maxDesiredLevel      int
	capitalReserveFactor int64
	maxBuysPerTick       int

	// Adaptación y pivote (ver `adaptar` y `evaluarPivote`).
	ad adaptacion

	// Fin del turno en modo rotación (cero si no hay rotación). Ver
	// `cerrandoTurno`.
	finTurno time.Time
}

// ConTurno marca cuándo termina el turno activo de este bot (modo rotación).
func (s *ProducerStrategy) ConTurno(fin time.Time) *ProducerStrategy {
	s.finTurno = fin
	return s
}

// cerrandoTurno: ¿estamos en el último tramo del turno de rotación?
//
// Arrancar una transformación aquí es pagar el salario por adelantado para que
// el output aparezca cuando el bot ya está desconectado, se quede sin ask
// durante todo el ciclo de rotación (los suyos expiran) y no se venda hasta el
// turno siguiente. Vender y cancelar sí se sigue haciendo: eso sí aprovecha los
// minutos que quedan.
func (s *ProducerStrategy) cerrandoTurno() bool {
	if s.finTurno.IsZero() {
		return false
	}
	return time.Until(s.finTurno) < 90*time.Second
}

type producerParams struct {
	minMargin     float64 // margen minimo sobre coste: gate de produccion y suelo de venta
	targetMargin  float64 // margen objetivo cuando no hay ask que mejorar
	crossProb     float64 // probabilidad de cruzar el ask por insumos (si el margen aguanta)
	bootstrapCap  float64 // tope sobre el fair que se paga por un insumo con stock CERO
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

func NewProducerStrategy(oficio Oficio, catalogo *CatalogoOficios) *ProducerStrategy {
	maxNivel := oficio.MaxNivel
	if maxNivel <= 0 {
		maxNivel = 3
	}
	return &ProducerStrategy{
		basePrices:           make(map[string]int64),
		simTimeFactor:        5,
		maxRecipesPerTick:    8,
		maxDesiredLevel:      maxNivel,
		capitalReserveFactor: 3,
		maxBuysPerTick:       1,
		oficio:               oficio,
		catalogo:             catalogo,
	}
}

func (s *ProducerStrategy) Initialize(ctx *strategy.Context) error {
	s.rnd = newStrategyRand(ctx)
	s.agentID, _, s.role, _ = ctx.State.GetAgentInfo()
	s.basePrices = resolveBasePrices(ctx)
	s.view = newMarketView(ctx, s.basePrices)
	s.bank = loadBankWindow(ctx)
	s.simTimeFactor = configFloat(ctx.Config, "sim_time_factor", s.simTimeFactor)
	s.maxRecipesPerTick = configInt(ctx.Config, "max_recipes_per_tick", s.maxRecipesPerTick)
	s.p = producerParams{
		minMargin:     sampleRange(s.rnd, 0.05, 0.2),
		targetMargin:  sampleRange(s.rnd, 0.2, 0.5),
		crossProb:     sampleRange(s.rnd, 0.3, 0.7),
		bootstrapCap:  sampleRange(s.rnd, 1.15, 1.4),
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
	// Freno por almacén: el suelo de venta NUNCA baja del coste. Para esta
	// estrategia "coste por encima del fair" no es un episodio de stock
	// sobrecosteado que convenga liquidar despacio (que es lo que modela
	// liqCap), sino su estado permanente: es la productora marginal. Acumular y
	// parar, no rematar.
	if s.oficio.Freno == frenoAlmacen {
		s.p.liqCap = 1e9
	}
	s.ad.init(s.rnd, s.p)

	s.resolverOficio(ctx)
	ctx.Logger.Info("ProducerStrategy v2 inicializada",
		"oficio", s.oficio.Key,
		"recetas", len(s.recetas),
		"tape_products", len(s.subscribed),
		"max_nivel", s.maxDesiredLevel,
	)
	return nil
}

// resolverOficio traduce el oficio a recetas del catálogo y recalcula el
// universo de tape al que hay que suscribirse. Se llama en `Initialize` y en
// cada pivote.
func (s *ProducerStrategy) resolverOficio(ctx *strategy.Context) {
	recetas, degradado := ResolverRecetas(ctx, s.oficio)
	if degradado {
		ctx.Logger.Warn("el servidor no expone recipe.key: el oficio degrada a "+
			"todas las recetas de sus tipos (comportamiento bots-v1). "+
			"Arreglo: bun src/scripts/backfill-recipe-keys.ts",
			"oficio", s.oficio.Key)
	}
	if len(recetas) == 0 {
		ctx.Logger.Warn("oficio sin recetas resueltas: el bot no producirá nada",
			"oficio", s.oficio.Key)
	}
	s.recetas = recetas

	// Suscripción de tape (fan-out selectivo): insumos y outputs de sus recetas
	// —todo lo que compra y todo lo que vende—, más el oro si hay ventanilla.
	seen := make(map[string]bool)
	for _, recipe := range recetas {
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
}

// wagePerExecCents es el salario por ejecucion en cents (el servidor cobra
// por segundos SIMULADOS; DurationSeconds llega en reales).
func (s *ProducerStrategy) wagePerExecCents(recipe models.Recipe) int64 {
	return int64(float64(recipe.WageRateCentsPerSec*recipe.DurationSeconds) * s.simTimeFactor)
}

// outputFair devuelve el fair del output con el suelo de la ventanilla del
// banco para el oro: el banco garantiza window_bid, así que el precio efectivo
// nunca es menor.
func (s *ProducerStrategy) outputFair(productID string) (int64, bool) {
	fair, has := s.view.Fair(productID)
	if s.bank.enabled && productID == s.bank.goldProductID && (!has || fair < s.bank.windowBid) {
		return s.bank.windowBid, true
	}
	return fair, has
}

// execEconomics valora una ejecucion de la receta a precios fair: coste de
// insumos, salario e ingreso del output. ok=false si falta el fair de alguna
// pata. El ingreso se calcula sobre el output EFECTIVO, no el nominal (ADR-023).
func (s *ProducerStrategy) execEconomics(
	ctx *strategy.Context,
	recipe models.Recipe,
) (inputsCost, wage, revenue int64, ok bool) {
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
	revenue = notionalCents(effectiveOutputQtyCent(ctx, recipe), fairOut)
	return inputsCost, wage, revenue, true
}

// costeUnitario reparte el coste de una ejecución (insumos + salario) entre las
// unidades que esa ejecución produce DE VERDAD (ADR-023). Es el suelo de venta.
func (s *ProducerStrategy) costeUnitario(ctx *strategy.Context, recipe models.Recipe) (int64, bool) {
	inputsCost, wage, _, priced := s.execEconomics(ctx, recipe)
	if !priced {
		return 0, false
	}
	base := effectiveOutputQtyCent(ctx, recipe)
	if base <= 0 {
		// Yacimiento agotado: lo que queda en inventario costó MÁS, porque se
		// extrajo con rendimiento parcial. Dividir por el nominal es lo
		// conservador; sin esta pata el bot remataría sin suelo justo el bien
		// más escaso del mercado.
		base = recipe.OutputQtyCent
	}
	if base <= 0 {
		return 0, false
	}
	return (inputsCost + wage) * 100 / base, true
}

// masBarata: ¿`a` produce su output más barato que `b`?
func (s *ProducerStrategy) masBarata(ctx *strategy.Context, a, b models.Recipe) bool {
	costeA, okA := s.costeUnitario(ctx, a)
	if !okA {
		return false
	}
	costeB, okB := s.costeUnitario(ctx, b)
	return !okB || costeA < costeB
}

// askDeOtro: ¿el mejor ask del libro es de OTRO agente? Nuestra propia oferta no
// es competencia. Sin este filtro el bot se apaga solo: lista su producción, lee
// su propio ask al tick siguiente y concluye que alguien vende bajo su coste.
func (s *ProducerStrategy) askDeOtro(top *models.TopOfBook) bool {
	return top != nil && top.BestAsk != nil && top.BestAsk.AgentID != s.agentID
}

// ordenDeRecetas decide a qué recetas se atiende primero.
//
// El orden importa de verdad: el nivel de la instalación es un presupuesto de
// concurrencia COMPARTIDO por las recetas del tipo (ADR-021), así que con nivel
// 1 solo corre una y se la queda la primera que se atiende, junto con el
// capital que va a sus insumos. v1 lo echaba a suertes con `rnd.Perm` (y el
// energético necesitó una función de prioridad ad hoc para que la hidro no
// perdiera el sorteo). Aquí se ordena por MARGEN esperado: con líneas escasas,
// se produce lo que más renta. El desempate sigue siendo aleatorio para que dos
// recetas de margen parecido no se resuelvan siempre a favor de la misma.
func (s *ProducerStrategy) ordenDeRecetas(ctx *strategy.Context, producible []models.Recipe) []int {
	orden := s.rnd.Perm(len(producible))
	margen := make([]float64, len(producible))
	for i, recipe := range producible {
		inputsCost, wage, revenue, ok := s.execEconomics(ctx, recipe)
		coste := inputsCost + wage
		if !ok || coste <= 0 {
			// Sin valorar: al final, pero no descartada (puede ser la única que
			// el bot sabe hacer y el fair aparece en cuanto imprima un trade).
			margen[i] = -1
			continue
		}
		margen[i] = float64(revenue)/float64(coste) - 1
	}
	sort.SliceStable(orden, func(a, b int) bool {
		return margen[orden[a]] > margen[orden[b]]
	})
	return orden
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

	producible := s.recetas
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
	// encima del buffer que consumimos: el agricultor que compra agua para regar
	// no la revende, y el que produce sus semillas vende el excedente, no la
	// simiente del año que viene.
	recipeByOutput := make(map[string]models.Recipe)
	reservado := make(map[string]int64)
	handledInputs := make(map[string]bool)
	recipesActed := 0
	buysActed := 0
	// Los slots son un presupuesto compartido por tipo (ADR-021) y el estado
	// local no se actualiza hasta que el engine ejecuta las acciones: sin
	// descontar lo comprometido en este mismo tick, dos recetas del mismo tipo
	// verían libre el mismo hueco y la segunda moriría con 422.
	slotsCommitted := make(map[string]int)
	typesBought := make(map[string]bool)
	orden := s.ordenDeRecetas(ctx, producible)
	// Qué recetas tienen derecho a reponer insumos: tantas por tipo como líneas
	// tenga la instalación, por orden de prioridad. Una sola línea no puede
	// alimentar tres recetas a la vez, y repartir el capital entre las tres deja
	// bids vivos en mercados que nadie surte.
	abastecible := make(map[string]bool)
	cuota := make(map[string]int)
	for _, idx := range orden {
		recipe := producible[idx]
		inst, typ, owned, typeKnown := installationForRecipe(ctx, recipe)
		if !typeKnown {
			continue
		}
		// El tipo aún sin comprar cuenta como una línea: es el arranque, y sin
		// insumos la instalación que compre nacería parada.
		if effectiveOutputQtyCent(ctx, recipe) > 0 && cuota[typ.Key] < max(inst.Level, 1) {
			cuota[typ.Key]++
			abastecible[recipe.RecipeID] = true
		}
		if !owned {
			continue
		}
		// Varias recetas pueden producir el MISMO output: nos quedamos con la
		// más barata por unidad, que es el coste marginal de reponerla y el
		// suelo de venta honesto.
		if previa, ya := recipeByOutput[recipe.OutputProductID]; !ya ||
			s.masBarata(ctx, recipe, previa) {
			recipeByOutput[recipe.OutputProductID] = recipe
		}
		if effectiveOutputQtyCent(ctx, recipe) <= 0 {
			continue
		}
		buffLevel := max(inst.Level, 1)
		for _, input := range recipe.Inputs {
			target := input.QtyRequiredCent * int64(buffLevel) * int64(s.p.bufferExecs)
			if target > reservado[input.ProductID] {
				reservado[input.ProductID] = target
			}
		}
	}

	produjoAlgo := false
	huboMargen := false
	for _, idx := range orden {
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

		// Yacimiento agotado (ADR-023): la receta está muerta para el resto de la
		// corrida. Ni producir ni comprar la instalación para producirla.
		outputEfectivo := effectiveOutputQtyCent(ctx, recipe)
		if outputEfectivo <= 0 {
			continue
		}

		inputsCost, wage, revenue, priced := s.execEconomics(ctx, recipe)
		profitable := priced && float64(revenue) >= float64(inputsCost+wage)*(1+s.p.minMargin)

		if !profitable && priced {
			// Sin margen a precios de mercado, todavía se produce si NADIE MÁS
			// lo está ofreciendo por debajo de nuestro coste: el productor
			// marginal es el que descubre el precio.
			//
			// El suelo depende del modo de apagado del oficio. Con
			// `coste_variable` no se le suma el margen: la generadora marginal
			// (la hidro, ~32 ¢/kWh contra un fair anclado en los ~27 de la
			// térmica de carbón) se apagaría casi siempre con el criterio
			// genérico, y entonces las 95 recetas industriales que consumen
			// electricidad se quedan sin insumo el día que el carbón se agote.
			floor := float64(inputsCost + wage)
			if s.oficio.Apagado != apagadoCosteVariable {
				floor *= 1 + s.p.minMargin
			}
			topOut := s.view.Top(ctx, recipe.OutputProductID)
			if !s.askDeOtro(topOut) ||
				float64(notionalCents(outputEfectivo, topOut.BestAsk.PriceCents)) >= floor {
				profitable = true
			}
		}
		if profitable {
			huboMargen = true
		}

		// A0. Comprar/mejorar la instalación del tipo si la receta es rentable
		// pero la producción está bloqueada por falta de huecos (ADR-021).
		// Los insumos van SIEMPRE por delante del capex: una mejora que deje al
		// bot sin con qué alimentar la línea nueva no aumenta la producción, la
		// para.
		compradaEsteTick := false
		if profitable && (!owned || inst.AvailableSlots <= 0) &&
			!typesBought[typ.Key] && buysActed < s.maxBuysPerTick &&
			(!owned || insumosCubrenNivelExtra(ctx, recipe, inst, activeBuyQty)) {
			trabajo := (inputsCost + wage) * int64(inst.Level+1) * int64(s.p.bufferExecs)
			if buy, price, ok := installationBuyAction(inst, typ, owned, capitalAvail,
				trabajo, s.maxDesiredLevel, s.capitalReserveFactor); ok {
				acts = append(acts, buy)
				buysActed++
				typesBought[typ.Key] = true
				capitalAvail -= price
				compradaEsteTick = true
			}
		}

		// A. Arrancar ejecuciones.
		if !compradaEsteTick && profitable && owned && inst.AvailableSlots > 0 &&
			!s.almacenLleno(ctx, recipe, inst) && !s.cerrandoTurno() {
			maxExecutions := inst.AvailableSlots
			for _, input := range recipe.Inputs {
				inv := ctx.State.InventoryForProduct(input.ProductID)
				possible := int(inv.QtyAvailableCent / input.QtyRequiredCent)
				if possible < maxExecutions {
					maxExecutions = possible
				}
			}
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
				produjoAlgo = true
			}
		}

		// B. Reponer insumos solo para recetas rentables y solo para tantas
		// recetas por tipo como líneas tenga la instalación.
		if !profitable || !abastecible[recipe.RecipeID] {
			continue
		}
		for _, input := range recipe.Inputs {
			if handledInputs[input.ProductID] {
				continue
			}
			handledInputs[input.ProductID] = true
			inv := ctx.State.InventoryForProduct(input.ProductID)
			buffLevel := inst.Level
			if compradaEsteTick {
				buffLevel++
			}
			if buffLevel < 1 {
				buffLevel = 1
			}
			targetQty := input.QtyRequiredCent * int64(buffLevel) * int64(s.p.bufferExecs)
			// Parado: no hay ni para UNA ejecución. Aunque el buffer parezca
			// cubierto por bids vivos, esos bids pueden llevar horas sin
			// cruzarse; seguir cotizando es lo único que desatasca la línea.
			parado := inv.QtyAvailableCent < input.QtyRequiredCent
			currentQty := inv.QtyAvailableCent + activeBuyQty[input.ProductID]
			if currentQty >= targetQty && !parado {
				continue
			}
			fairIn, has := s.view.Fair(input.ProductID)
			if !has {
				continue
			}

			price := int64(float64(fairIn) * (1 - s.p.restingDisc))
			if top := s.view.Top(ctx, input.ProductID); top != nil && top.BestAsk != nil && chance(s.rnd, s.p.crossProb) {
				askExtra := notionalCents(input.QtyRequiredCent, top.BestAsk.PriceCents) -
					notionalCents(input.QtyRequiredCent, fairIn)
				if float64(revenue) >= float64(inputsCost+askExtra+wage)*(1+s.p.minMargin) {
					price = top.BestAsk.PriceCents
				}
			}
			// Arranque en frío: quien tiene la línea parada por falta de insumo
			// no regatea. A precios base el gate de arriba nunca deja cruzar
			// (revenue == coste por construcción) y el libro se queda con las
			// dos puntas sin tocarse; sin esta pata la cadena no arranca nunca
			// desde inventario cero (ADR-022).
			if parado {
				if top := s.view.Top(ctx, input.ProductID); top != nil && top.BestAsk != nil &&
					float64(top.BestAsk.PriceCents) <= float64(fairIn)*s.p.bootstrapCap {
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
		// monetiza ahí (dinero acuñado) en vez de listar asks.
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
		pos.QtyAvailableCent -= reservado[pos.ProductID]
		if pos.QtyAvailableCent <= 0 {
			continue
		}
		costPU, _ := s.costeUnitario(ctx, recipe)
		acts = append(acts, sellAtMarket(ctx, s.rnd, s.view, pos, costPU, sellParams{
			MinMargin:     s.p.minMargin,
			TargetMargin:  s.p.targetMargin,
			Undercut:      s.p.undercut,
			Tranche:       s.p.tranche,
			RequoteThresh: s.p.requoteThresh,
			LiqCap:        s.p.liqCap,
		})...)
	}

	s.adaptar(ctx, recipeByOutput)
	if s.evaluarPivote(ctx, produjoAlgo, huboMargen) {
		// Tras pivotar no se emiten las acciones calculadas con el oficio
		// viejo: comprarían insumos de un nicho que el bot acaba de abandonar.
		return nil
	}
	return acts
}

// almacenLleno implementa el freno por ALMACÉN (`freno: almacen`).
//
// El freno normal es el precio: si el output no cubre coste + margen, se deja de
// producir. Pero un oficio que se apaga por coste variable (la hidro) casi nunca
// alcanza ese punto, así que sin un segundo freno seguiría turbinando contra un
// almacén que no se vacía y pagando salarios por stock invendible. Aquí para
// cuando acumula `inventario_max_execs` ejecuciones por línea.
func (s *ProducerStrategy) almacenLleno(
	ctx *strategy.Context,
	recipe models.Recipe,
	inst models.InstallationStatus,
) bool {
	if s.oficio.Freno != frenoAlmacen {
		return false
	}
	maxExecs := s.oficio.InventarioMaxExecs
	if maxExecs <= 0 {
		maxExecs = 6
	}
	porEjecucion := effectiveOutputQtyCent(ctx, recipe)
	if porEjecucion <= 0 {
		return false
	}
	tope := porEjecucion * int64(maxExecs) * int64(max(inst.Level, 1))
	return ctx.State.InventoryForProduct(recipe.OutputProductID).QtyAvailableCent >= tope
}

// SubscribedProducts implementa strategy.ProductSubscriber: el engine suscribe
// el WS solo al tape de estos productos.
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
	case events.TransformationCompleted:
		ctx.Logger.Debug("transformación completada", "recipe_id", ev.RecipeID)
	case events.BankruptcyNotice:
		ctx.Logger.Warn("aviso de quiebra", "agent_id", ev.AgentID, "oficio", s.oficio.Key)
	}
	return nil
}
