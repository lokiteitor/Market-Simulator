package main

import (
	"fmt"
	"math/rand/v2"
	"sort"
	"sync"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/botkit"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// HidroStrategy es un generador hidroeléctrico puro: compra agua, la turbina y
// vende electricidad. Nada más.
//
// Por qué un binario aparte y no otra especialidad de bots-v1 (ADR-024): el
// `energetico` de bots-v1 se queda con TODO el tipo `generacion` —hidro y las
// dos térmicas— y las tres recetas se disputan el nivel de la instalación, que
// es un presupuesto de concurrencia compartido (ADR-021). Con nivel 1 solo corre
// una; `prioridadRenovablePrimero` empuja la hidro delante, pero en cuanto el
// bot escala a nivel 2-3 las térmicas ocupan las líneas nuevas, que es lo
// razonable para un generalista: son más baratas por kWh (27 y 31 ¢ contra los
// ~32 de la hidro). El resultado es que la capacidad renovable del mundo es un
// residuo del arranque, no una decisión.
//
// Este bot invierte esa relación: el 100% de su nivel es hidro, así que el
// parque renovable crece con la demanda en vez de encogerse en cuanto hay
// carbón en el libro. Eso importa por ADR-023: carbón y gas salen de yacimientos
// finitos y el día que se agoten la hidro es la única generación que queda en
// pie. Si para entonces nadie construyó centrales hidráulicas, la industria
// entera —las 113 recetas que consumen electricidad— se para de golpe.
//
// Las tres diferencias de comportamiento frente al productor genérico:
//
//   - Solo produce recetas de `generacion` cuyos insumos son TODOS renovables
//     (agua). No es un filtro por nombre: la API no expone la key de la receta,
//     así que se comprueba insumo a insumo contra la lista blanca del config y
//     contra los yacimientos (ADR-023).
//   - Margen mínimo bajo y apagado tardío: la hidro es la generadora MARGINAL
//     por construcción, así que el criterio del productor genérico —parar si
//     alguien vende más barato que coste+margen— la apagaría casi siempre, con
//     una térmica de carbón en el libro. Aquí solo para si el precio ajeno deja
//     de cubrir el coste VARIABLE, que es cuando generar sí destruye capital.
//   - Tope de inventario: como no se apaga por precio, se apaga por stock. Si la
//     electricidad se acumula sin venderse, deja de turbinar en vez de seguir
//     pagando salarios contra un almacén que nadie compra.
type HidroStrategy struct {
	mu  sync.Mutex
	rnd *rand.Rand

	view          *botkit.MarketView
	basePrices    map[string]int64
	simTimeFactor float64
	p             hidroParams

	// tipoKey es la key del tipo de instalación que se compra (`generacion`) y
	// renovables la lista blanca de insumos (keys de producto) que hace que una
	// de sus recetas cuente como hidroeléctrica.
	tipoKey    string
	renovables map[string]bool

	// recetas: las recetas hidro del catálogo, resueltas en Initialize. Es una
	// lista y no una sola porque el catálogo puede ganar mañana otra generación
	// renovable (eólica, solar) sin tocar este bot.
	recetas    []models.Recipe
	subscribed []string

	agentID string
	role    models.AgentRole

	maxDesiredLevel      int
	capitalReserveFactor int64
	// inventarioMaxExecs: cuántas ejecuciones de producto sin vender se toleran
	// por línea antes de parar la generación.
	inventarioMaxExecs int64
}

type hidroParams struct {
	minMargin     float64 // margen minimo sobre coste: gate de produccion y suelo de venta
	targetMargin  float64 // margen objetivo cuando no hay ask que mejorar
	crossProb     float64 // probabilidad de cruzar el ask por el agua (si el margen aguanta)
	bootstrapCap  float64 // tope sobre el fair que se paga por el agua con stock CERO
	bufferExecs   int     // ejecuciones de buffer de agua por linea
	restingDisc   float64 // descuento del bid de descanso vs fair del agua
	undercut      float64 // rebaja relativa sobre el mejor ask al vender
	tranche       float64 // fraccion del inventario listada por tick
	requoteThresh float64 // desviacion que dispara cancel/replace
	actProb       float64
	skipTickProb  float64
	liqCap        float64 // techo del suelo relativo al fair (modo liquidacion)
	capitalDen    int64   // presupuesto de compra por tick = capital / capitalDen
	restBudget    int
}

func NewHidroStrategy() *HidroStrategy {
	return &HidroStrategy{
		basePrices:    make(map[string]int64),
		simTimeFactor: 5,
		tipoKey:       "generacion",
		renovables:    map[string]bool{"agua": true},
		// Más alto que el 3 del productor genérico y que el 4 del `energetico`:
		// este bot existe justamente para acumular capacidad renovable, y su
		// única receta no compite con nadie por las líneas que compra.
		maxDesiredLevel:      6,
		capitalReserveFactor: 3,
		inventarioMaxExecs:   6,
	}
}

func (s *HidroStrategy) Initialize(ctx *strategy.Context) error {
	s.rnd = botkit.NewStrategyRand(ctx)
	s.agentID, _, s.role, _ = ctx.State.GetAgentInfo()
	s.basePrices = botkit.ResolveBasePrices(ctx)
	s.view = botkit.NewMarketView(ctx, s.basePrices)
	s.simTimeFactor = botkit.ConfigFloat(ctx.Config, "sim_time_factor", s.simTimeFactor)
	s.maxDesiredLevel = botkit.ConfigInt(ctx.Config, "max_desired_level", s.maxDesiredLevel)
	s.inventarioMaxExecs = int64(botkit.ConfigInt(ctx.Config, "inventario_max_execs", int(s.inventarioMaxExecs)))
	if tipo, ok := ctx.Config["tipo_instalacion"].(string); ok && tipo != "" {
		s.tipoKey = tipo
	}
	if keys := configStrings(ctx.Config, "insumos_renovables"); len(keys) > 0 {
		s.renovables = make(map[string]bool, len(keys))
		for _, k := range keys {
			s.renovables[k] = true
		}
	}

	s.p = hidroParams{
		// Rango deliberadamente más estrecho y más bajo que el del productor
		// genérico (0,05-0,2): el marginal no puede exigir el margen del
		// inframarginal o no vende nunca.
		minMargin:     botkit.SampleRange(s.rnd, 0.02, 0.08),
		targetMargin:  botkit.SampleRange(s.rnd, 0.1, 0.3),
		crossProb:     botkit.SampleRange(s.rnd, 0.4, 0.8),
		bootstrapCap:  botkit.SampleRange(s.rnd, 1.15, 1.4),
		bufferExecs:   botkit.SampleIntRange(s.rnd, 3, 6),
		restingDisc:   botkit.SampleRange(s.rnd, 0.02, 0.06),
		undercut:      botkit.SampleRange(s.rnd, 0.01, 0.03),
		tranche:       botkit.SampleRange(s.rnd, 0.3, 0.7),
		requoteThresh: botkit.SampleRange(s.rnd, 0.02, 0.05),
		actProb:       botkit.SampleRange(s.rnd, 0.75, 1.0),
		skipTickProb:  botkit.SampleRange(s.rnd, 0.05, 0.2),
		liqCap:        botkit.SampleRange(s.rnd, 1.2, 1.5),
		capitalDen:    int64(botkit.SampleIntRange(s.rnd, 2, 4)),
		restBudget:    int(botkit.MarketCfgFloat(ctx.Config, "rest_budget_per_tick", 4)),
	}

	s.recetas = s.recetasRenovables(ctx)
	if len(s.recetas) == 0 {
		// Sin receta renovable este bot no tiene nada que hacer: mejor abortar el
		// arranque —el runner lo reporta— que dejar una conexión abierta girando
		// en vacío. Pasa si el catálogo no trae `generacion` o si sus recetas
		// consumen algo que no está en la lista blanca.
		return fmt.Errorf(
			"el catálogo no tiene ninguna receta de %q con insumos exclusivamente renovables (%v)",
			s.tipoKey, keysDe(s.renovables),
		)
	}

	seen := make(map[string]bool)
	for _, r := range s.recetas {
		for _, in := range r.Inputs {
			seen[in.ProductID] = true
		}
		seen[r.OutputProductID] = true
	}
	s.subscribed = make([]string, 0, len(seen))
	for id := range seen {
		s.subscribed = append(s.subscribed, id)
	}

	ctx.Logger.Info("HidroStrategy initialized",
		"recetas_hidro", len(s.recetas),
		"tipo_instalacion", s.tipoKey,
		"tape_products", len(s.subscribed),
		"max_desired_level", s.maxDesiredLevel,
		"min_margin", s.p.minMargin,
	)
	return nil
}

// recetasRenovables selecciona, entre las recetas del tipo de instalación, las
// que este bot considera hidroeléctricas: TODOS sus insumos están en la lista
// blanca y ninguno sale de un yacimiento finito (ADR-023).
//
// Las dos condiciones no sobran una a la otra. La lista blanca es la que manda
// —es explícita y no depende de la red—, porque `GET /catalog/deposits` puede
// fallar al arrancar y el engine sigue adelante asumiendo recursos infinitos
// (ver Start): con solo el criterio del yacimiento, ese fallo convertiría a este
// bot en un generalista que quema carbón. El yacimiento es el cinturón: si
// mañana alguien mete en la lista blanca un insumo que resulta ser finito, la
// receta se descarta igual.
func (s *HidroStrategy) recetasRenovables(ctx *strategy.Context) []models.Recipe {
	out := make([]models.Recipe, 0, 4)
	for _, recipe := range ctx.State.CatalogRecipes() {
		typ, ok := ctx.State.InstallationTypeByID(recipe.InstallationTypeID)
		if !ok || typ.Key != s.tipoKey || models.AgentRole(typ.Role) != s.role {
			continue
		}
		if len(recipe.Inputs) == 0 {
			continue // una generación sin insumos no existe en este catálogo
		}
		renovable := true
		for _, in := range recipe.Inputs {
			producto, known := ctx.State.Product(in.ProductID)
			if !known || !s.renovables[producto.Key] {
				renovable = false
				break
			}
			if _, finito := ctx.State.Deposit(in.ProductID); finito {
				renovable = false
				break
			}
		}
		if renovable {
			out = append(out, recipe)
		}
	}
	return out
}

// valoracion es una receta hidro tasada a precios de mercado en este tick.
type valoracion struct {
	recipe     models.Recipe
	inputsCost int64 // coste de los insumos de UNA ejecución
	wage       int64 // salario de UNA ejecución (segundos simulados)
	revenue    int64 // ingreso de UNA ejecución al fair del output
	costeUnit  int64 // coste por unidad realmente producida: el suelo de venta
	output     int64 // output EFECTIVO de una ejecución (ADR-023)
	priced     bool  // false si falta el fair de alguna pata
}

// valorar tasa una ejecución. El salario corre en centavos por segundo REAL
// mientras la duración de la receta viene en tiempo simulado, de ahí el factor.
func (s *HidroStrategy) valorar(ctx *strategy.Context, recipe models.Recipe) valoracion {
	v := valoracion{recipe: recipe, output: botkit.EffectiveOutputQtyCent(ctx, recipe)}
	for _, in := range recipe.Inputs {
		fairIn, has := s.view.Fair(in.ProductID)
		if !has {
			return v
		}
		v.inputsCost += botkit.NotionalCents(in.QtyRequiredCent, fairIn)
	}
	fairOut, has := s.view.Fair(recipe.OutputProductID)
	if !has {
		return v
	}
	v.wage = int64(float64(recipe.WageRateCentsPerSec*recipe.DurationSeconds) * s.simTimeFactor)
	v.revenue = botkit.NotionalCents(v.output, fairOut)
	base := v.output
	if base <= 0 {
		base = recipe.OutputQtyCent
	}
	if base > 0 {
		v.costeUnit = (v.inputsCost + v.wage) * 100 / base
	}
	v.priced = true
	return v
}

func (v valoracion) costeEjecucion() int64 { return v.inputsCost + v.wage }

// genera decide si turbinar. Es el punto donde este bot se separa del productor
// genérico, que para en cuanto alguien vende por debajo de coste+margen.
//
// La hidro es la generadora marginal por construcción: cuesta ~32 ¢/kWh contra
// los ~27 de la térmica de carbón, así que el criterio genérico la apaga
// siempre que haya una térmica ofertando —o sea, casi siempre— y el parque
// renovable no se construye nunca. Aquí el gate se relaja en un solo sentido: si
// el fair no da el margen, se mira si hay competencia REAL (un ask AJENO; el
// propio no cuenta, o el bot se apaga con su misma oferta) y solo se para
// cuando ese precio ni siquiera cubre el coste VARIABLE. Producir con margen
// fino es sostenible; producir por debajo del coste variable es quemar capital.
func (s *HidroStrategy) genera(ctx *strategy.Context, v valoracion) bool {
	if !v.priced || v.output <= 0 {
		return false
	}
	coste := float64(v.costeEjecucion())
	if float64(v.revenue) >= coste*(1+s.p.minMargin) {
		return true
	}
	top := s.view.Top(ctx, v.recipe.OutputProductID)
	if !s.askDeOtro(top) {
		return true
	}
	return float64(botkit.NotionalCents(v.output, top.BestAsk.PriceCents)) >= coste
}

// askDeOtro: ¿el mejor ask del libro es de OTRO agente? El top-of-book trae el
// agent_id de la punta, así que la comprobación es exacta.
func (s *HidroStrategy) askDeOtro(top *models.TopOfBook) bool {
	return top != nil && top.BestAsk != nil && top.BestAsk.AgentID != s.agentID
}

func (s *HidroStrategy) Tick(ctx *strategy.Context) []actions.Action {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, _, _, status := ctx.State.GetAgentInfo(); status == models.StatusBankrupt {
		return nil
	}
	if botkit.Chance(s.rnd, s.p.skipTickProb) {
		return nil
	}
	s.view.BeginTick(s.p.restBudget)

	activeOrders := ctx.State.ActiveOrders()
	capitalAvail, _ := ctx.State.Capital()
	activeBuyQty := make(map[string]int64)
	for _, o := range activeOrders {
		if o.Side == models.SideBuy {
			activeBuyQty[o.ProductID] += o.QtyPendingCent
		}
	}

	// Orden de atención: la hidro más barata por kWh primero. Con una sola receta
	// en el catálogo actual es un no-op, pero si mañana hay eólica o solar el
	// nivel de la instalación —presupuesto compartido (ADR-021)— debe irse a la
	// que produce el kWh más barato, no a la primera del catálogo.
	valoradas := make([]valoracion, 0, len(s.recetas))
	for _, r := range s.recetas {
		valoradas = append(valoradas, s.valorar(ctx, r))
	}
	sort.SliceStable(valoradas, func(a, b int) bool {
		if valoradas[a].priced != valoradas[b].priced {
			return valoradas[a].priced // una receta sin tasar nunca va delante
		}
		return valoradas[a].costeUnit < valoradas[b].costeUnit
	})

	var acts []actions.Action
	// Presupuesto de concurrencia comprometido en ESTE tick: el estado local no
	// se refresca hasta el próximo snapshot, así que sin descontarlo dos recetas
	// verían libre el mismo hueco y la segunda moriría con 422
	// recipe_capacity_saturated.
	slotsCommitted := 0
	compradoEsteTick := false
	abastecida := false
	reservado := make(map[string]int64)
	// La receta con la que se valora el inventario para venderlo: la más barata
	// de las que sabemos ejecutar. Es el coste marginal de reponer el kWh y, por
	// tanto, el suelo de venta honesto.
	var recetaDeVenta valoracion

	for _, v := range valoradas {
		recipe := v.recipe
		if !botkit.Chance(s.rnd, s.p.actProb) {
			continue
		}
		inst, typ, owned, typeKnown := botkit.InstallationForRecipe(ctx, recipe)
		if !typeKnown {
			continue
		}
		if !recetaDeVenta.priced && v.priced {
			recetaDeVenta = v
		}
		inst.AvailableSlots -= slotsCommitted
		if inst.AvailableSlots < 0 {
			inst.AvailableSlots = 0
		}
		lineas := max(inst.Level, 1)

		produce := s.genera(ctx, v)
		// Freno por almacén: como el gate de precio casi nunca apaga la central,
		// lo que la apaga es no dar salida a la producción. Sin esto, un bot con
		// la electricidad invendible seguiría pagando salarios hasta quebrar.
		if produce && s.almacenLleno(ctx, v, lineas) {
			ctx.Logger.Debug("generación pausada: electricidad sin vender acumulada",
				"recipe_id", recipe.RecipeID)
			produce = false
		}

		// A. Comprar o mejorar la central cuando la producción renta pero no hay
		// líneas libres. Los insumos van SIEMPRE por delante del capex: una
		// turbina que nace sin agua no aumenta la generación, la para.
		if produce && (!owned || inst.AvailableSlots <= 0) && !compradoEsteTick &&
			(!owned || botkit.InsumosCubrenNivelExtra(ctx, recipe, inst, activeBuyQty)) {
			trabajo := v.costeEjecucion() * int64(inst.Level+1) * int64(s.p.bufferExecs)
			if buy, price, ok := botkit.InstallationBuyAction(inst, typ, owned, capitalAvail,
				trabajo, s.maxDesiredLevel, s.capitalReserveFactor); ok {
				acts = append(acts, buy)
				compradoEsteTick = true
				// Descontar ya lo comprometido: las acciones se ejecutan en orden,
				// así que las bids de agua de más abajo se dimensionan con el
				// capital que quedará DESPUÉS de pagar la central.
				capitalAvail -= price
				lineas++
			}
		}

		// B. Turbinar. No se arranca en el mismo tick que se compra la central:
		// el hueco nuevo no existe hasta que el servidor confirma la compra.
		if produce && owned && !compradoEsteTick && inst.AvailableSlots > 0 {
			execs := inst.AvailableSlots
			for _, in := range recipe.Inputs {
				inv := ctx.State.InventoryForProduct(in.ProductID)
				if posible := int(inv.QtyAvailableCent / in.QtyRequiredCent); posible < execs {
					execs = posible
				}
			}
			if v.wage > 0 {
				if porCapital := int(capitalAvail / v.wage); porCapital < execs {
					execs = porCapital
				}
			}
			if execs > 0 {
				if execs > 1 && botkit.Chance(s.rnd, 0.5) {
					execs = 1 + s.rnd.IntN(execs) // los operadores humanos dosifican
				}
				acts = append(acts, actions.StartTransformation{
					RecipeID:          recipe.RecipeID,
					ExecutionsPlanned: execs,
				})
				capitalAvail -= v.wage * int64(execs)
				slotsCommitted += execs
			} else {
				ctx.Logger.Debug("central con margen pero sin turbinar",
					"recipe_id", recipe.RecipeID, "slots", inst.AvailableSlots,
					"capital", capitalAvail, "wage", v.wage)
			}
		}

		// C. Reponer agua. Solo para UNA receta por tick —la primera de la lista,
		// que es la más barata—: el nivel es un presupuesto compartido, así que
		// abastecer a la segunda inmovilizaría capital en un insumo que no va a
		// caber en ninguna línea.
		if !produce || abastecida {
			continue
		}
		abastecida = true
		for _, in := range recipe.Inputs {
			target := in.QtyRequiredCent * int64(lineas) * int64(s.p.bufferExecs)
			reservado[in.ProductID] = target
			buy, gastado := s.reponerInsumo(ctx, v, in, target, activeOrders, activeBuyQty, capitalAvail)
			acts = append(acts, buy...)
			capitalAvail -= gastado
		}
	}

	// D. Vender la electricidad generada, con suelo de coste. Nunca se vende el
	// agua: es insumo comprado, no producción propia, y rematarla sería dejar la
	// central parada mañana.
	if recetaDeVenta.priced {
		acts = append(acts, s.venderProduccion(ctx, recetaDeVenta, reservado)...)
	}

	return acts
}

// almacenLleno: ¿hay ya más producto sin vender del que justifica seguir
// generando? El umbral se mide en ejecuciones por línea, así que escala con el
// tamaño de la central.
func (s *HidroStrategy) almacenLleno(ctx *strategy.Context, v valoracion, lineas int) bool {
	if s.inventarioMaxExecs <= 0 || v.output <= 0 {
		return false
	}
	inv := ctx.State.InventoryForProduct(v.recipe.OutputProductID)
	tope := v.output * s.inventarioMaxExecs * int64(lineas)
	return inv.QtyAvailableCent+inv.QtyReservedCent > tope
}

// reponerInsumo cotiza el agua que le falta a la central: bid de descanso bajo
// el fair, cruce del ask cuando el margen de la receta sobrevive pagándolo, y
// arranque en frío cuando la central está parada. Devuelve las acciones y el
// capital que comprometen.
func (s *HidroStrategy) reponerInsumo(
	ctx *strategy.Context,
	v valoracion,
	in models.RecipeInput,
	target int64,
	activeOrders []models.Order,
	activeBuyQty map[string]int64,
	capitalAvail int64,
) ([]actions.Action, int64) {
	inv := ctx.State.InventoryForProduct(in.ProductID)
	// Parado: no hay ni para UNA ejecución. Aunque el buffer parezca cubierto por
	// bids vivos, esos bids pueden llevar horas sin cruzarse; seguir cotizando
	// (y cruzar el ask, más abajo) es lo único que desatasca la central.
	parado := inv.QtyAvailableCent < in.QtyRequiredCent
	if inv.QtyAvailableCent+activeBuyQty[in.ProductID] >= target && !parado {
		return nil, 0
	}
	fairIn, has := s.view.Fair(in.ProductID)
	if !has {
		return nil, 0
	}

	price := int64(float64(fairIn) * (1 - s.p.restingDisc))
	top := s.view.Top(ctx, in.ProductID)
	if top != nil && top.BestAsk != nil && botkit.Chance(s.rnd, s.p.crossProb) {
		extra := botkit.NotionalCents(in.QtyRequiredCent, top.BestAsk.PriceCents) -
			botkit.NotionalCents(in.QtyRequiredCent, fairIn)
		if float64(v.revenue) >= float64(v.costeEjecucion()+extra)*(1+s.p.minMargin) {
			price = top.BestAsk.PriceCents
		}
	}
	// Arranque en frío: quien tiene la central parada por falta de agua no
	// regatea. Los precios base del catálogo son el COSTE propagado, así que a
	// precios base el gate de arriba nunca deja cruzar (revenue == coste por
	// construcción) y el libro se queda con las dos puntas sin tocarse. El
	// sobreprecio está acotado a bootstrapCap sobre el fair.
	if parado && top != nil && top.BestAsk != nil &&
		float64(top.BestAsk.PriceCents) <= float64(fairIn)*s.p.bootstrapCap {
		price = top.BestAsk.PriceCents
	}
	price = botkit.NicePrice(s.rnd, price)
	if price < 1 {
		return nil, 0
	}

	cancels, liveBuy, _ := botkit.CancelStale(activeOrders, in.ProductID, models.SideBuy, price, s.p.requoteThresh)
	acts := cancels
	qty := target - (inv.QtyAvailableCent + liveBuy)
	if qty <= 0 {
		return acts, 0
	}
	qty = botkit.HumanQty(s.rnd, qty)
	if maxQty := botkit.MaxQtyForBudget(capitalAvail/s.p.capitalDen, price); qty > maxQty {
		qty = maxQty
	}
	if !botkit.IsReservable(qty, price) {
		return acts, 0
	}
	activeBuyQty[in.ProductID] += qty
	return append(acts, actions.PlaceOrder{
		ProductID:       in.ProductID,
		Side:            models.SideBuy,
		QtyCent:         qty,
		LimitPriceCents: price,
		TTLSeconds:      botkit.TTLJitter(s.rnd),
	}), botkit.NotionalCents(qty, price)
}

// venderProduccion lista el excedente de electricidad sobre lo que la propia
// central reserva. `reservado` protege los insumos, no el output —la
// electricidad no es insumo de esta receta—, pero se consulta igual para que el
// día que una generación renovable consuma su propio kWh siga sin rematárselo.
func (s *HidroStrategy) venderProduccion(
	ctx *strategy.Context,
	v valoracion,
	reservado map[string]int64,
) []actions.Action {
	if !botkit.Chance(s.rnd, s.p.actProb) {
		return nil
	}
	pos := ctx.State.InventoryForProduct(v.recipe.OutputProductID)
	pos.QtyAvailableCent -= reservado[v.recipe.OutputProductID]
	if pos.QtyAvailableCent <= 0 {
		return nil
	}
	return botkit.SellAtMarket(ctx, s.rnd, s.view, pos, v.costeUnit, botkit.SellParams{
		MinMargin:     s.p.minMargin,
		TargetMargin:  s.p.targetMargin,
		Undercut:      s.p.undercut,
		Tranche:       s.p.tranche,
		RequoteThresh: s.p.requoteThresh,
		LiqCap:        s.liqCapEfectivo(v),
	})
}

// liqCapEfectivo ajusta el techo del suelo de venta para que NUNCA quede por
// debajo del coste de generar.
//
// SellAtMarket recorta el suelo de coste a fair×LiqCap cuando el coste queda muy
// por encima del fair: es el modo liquidación, pensado para el productor que se
// quedó con stock sobrecosteado y prefiere venderlo despacio a descansar en un
// ask que nadie cruzará. Para esta central esa premisa es falsa. Su coste está
// por encima del fair de la electricidad SIEMPRE y por construcción —el fair
// está anclado al coste de la térmica de carbón, ~27 ¢/kWh contra los ~32 de la
// hidro—, así que el modo liquidación no sería un episodio: sería vender a
// pérdida cada tick hasta quebrar.
//
// El bot ya tiene su propia válvula para el stock que no sale: `almacenLleno`
// apaga la generación. Acumular y parar es la respuesta correcta a un mercado
// que no paga el kWh renovable; rematarlo, no.
func (s *HidroStrategy) liqCapEfectivo(v valoracion) float64 {
	fair, ok := s.view.Fair(v.recipe.OutputProductID)
	if !ok || fair <= 0 || v.costeUnit <= 0 {
		return s.p.liqCap
	}
	if minimo := float64(v.costeUnit) / float64(fair); minimo > s.p.liqCap {
		return minimo
	}
	return s.p.liqCap
}

// SubscribedProducts implementa strategy.ProductSubscriber: el engine suscribe
// el WS solo al tape del agua y la electricidad, que es todo lo que este bot
// compra y vende. Con cientos de generadores conectados, la diferencia frente
// al comodín "*" es de órdenes de magnitud en tráfico push.
func (s *HidroStrategy) SubscribedProducts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.subscribed...)
}

func (s *HidroStrategy) HandleEvent(ctx *strategy.Context, e events.Event) []actions.Action {
	switch ev := e.(type) {
	case events.TradePrinted:
		s.mu.Lock()
		s.view.OnTrade(ev)
		s.mu.Unlock()
	case events.OrderExecuted:
		ctx.Logger.Debug("orden ejecutada", "order_id", ev.OrderID,
			"product_id", ev.ProductID, "qty", ev.QtyExecutedCent, "price", ev.PriceCents)
	case events.TransformationCompleted:
		ctx.Logger.Debug("generación completada", "process_id", ev.ProcessID, "recipe_id", ev.RecipeID)
	case events.BankruptcyNotice:
		ctx.Logger.Warn("aviso de quiebra recibido", "agent_id", ev.AgentID)
	}
	return nil
}

// configStrings lee una lista de strings del mapa de configuración de
// estrategia, tolerando lo que produce YAML ([]interface{} de strings).
func configStrings(cfg map[string]interface{}, key string) []string {
	raw, ok := cfg[key]
	if !ok {
		return nil
	}
	switch val := raw.(type) {
	case []string:
		return val
	case []interface{}:
		out := make([]string, 0, len(val))
		for _, item := range val {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func keysDe(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
