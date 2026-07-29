package botkit

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

// ConsumerStrategy es la demanda final del mercado: las ciudades.
//
// Desde ADR-029 compra CONTRA UNA NECESIDAD, no a ciegas. El servidor le
// consume (y destruye) cada periodo una cesta proporcional a su poblacion, y
// expone esa necesidad en GET /agents/me/city-needs; la estrategia mantiene un
// STOCK OBJETIVO de varios periodos por producto y pide solo el hueco:
//
//	objetivo_i = necesidad_i x cobertura
//	faltante_i = objetivo_i - (disponible_i + pendiente_de_compra_i)
//
// Los productos se atienden por COBERTURA ASCENDENTE (lo que se va a acabar
// antes, primero) en vez de en orden aleatorio: con la cesta entera compitiendo
// por un presupuesto acotado, el orden es la politica de racionamiento.
//
// Aparte de la cesta, la ciudad AHORRA para comprar vivienda: es su unico bien
// de inversion (cada unidad suma habitantes, y sin reponerla la poblacion decae
// hasta el suelo). Una vivienda cuesta ~2.400 panes, asi que no cabe en el
// presupuesto de un tick: se reserva una cuota del capital y se compra cuando
// alcanza.
//
// El mecanismo de PRECIO no cambia: precio de reserva anclado al precio base
// (nunca al fair, para que la demanda no persiga al precio hacia arriba), y
// segun quepa o no en la reserva se levanta el mejor ask o se deja un bid de
// descanso bajo el fair.
type ConsumerStrategy struct {
	mu         sync.Mutex
	rnd        *rand.Rand
	view       *MarketView
	basePrices map[string]int64
	// Cesta y bien de inversion, resueltos del catalogo por urban_role.
	basketProducts []string
	housingProduct string
	// Necesidad por producto y periodo, del servidor. Vacio hasta el primer
	// refresco con exito; sin ella la estrategia no compra cesta (no adivina).
	needByProduct map[string]int64
	needsAt       time.Time
	needsStale    bool
	p             consumerParams
}

type consumerParams struct {
	tolerance float64 // reserva = base * tolerance
	spendRate float64 // fraccion del capital disponible gastable por tick
	// coverage: cuantos periodos de consumo se quieren tener en despensa.
	coverage      float64
	perTick       int     // productos considerados por tick
	crossProb     float64 // probabilidad de levantar un ask asequible
	restingDisc   float64 // descuento del bid de descanso vs fair
	skipTickProb  float64
	restBudget    int
	needsRefresh  time.Duration
	housingShare  float64 // cuota del capital reservada a vivienda
	housingMargin float64 // colchon sobre el precio antes de intentar comprar
}

// Cuota de la cesta que una ciudad mira en cada tick. Se dimensiona como
// FRACCIÓN y no como número fijo porque la cesta la define el catálogo: cada
// producto de consumo final que se añade le roba atención a los demás. Con el
// 3-8 fijo original, ampliar el catálogo bajaba la demanda por producto sin que
// nadie lo decidiera (los valores de aquí son ese mismo 3-8 sobre los 34
// finales que había entonces). `market.consumer_per_tick` lo fija a mano.
const (
	consumerPerTickShareMin = 0.09
	consumerPerTickShareMax = 0.24
	consumerPerTickMin      = 3
)

// Refresco por defecto de /agents/me/city-needs. La necesidad solo cambia con la
// población (que se mueve despacio) y el evento city_population_changed fuerza
// un refresco inmediato, así que el periodo puede ser holgado: con 50 ciudades
// esto es ~1,7 req/s contra el servidor.
const consumerNeedsRefreshDefault = 30 * time.Second

func consumerPerTick(rnd *rand.Rand, finales int, cfg map[string]interface{}) int {
	if fijo := int(MarketCfgFloat(cfg, "consumer_per_tick", 0)); fijo > 0 {
		return fijo
	}
	lo := max(consumerPerTickMin, int(float64(finales)*consumerPerTickShareMin+0.5))
	hi := max(lo, int(float64(finales)*consumerPerTickShareMax+0.5))
	return SampleIntRange(rnd, lo, hi)
}

func NewConsumerStrategy() *ConsumerStrategy {
	return &ConsumerStrategy{
		basePrices:    make(map[string]int64),
		needByProduct: make(map[string]int64),
	}
}

func (s *ConsumerStrategy) Initialize(ctx *strategy.Context) error {
	ctx.Logger.Info("ConsumerStrategy initializing...")
	s.rnd = NewStrategyRand(ctx)
	s.basePrices = ResolveBasePrices(ctx)
	s.view = NewMarketView(ctx, s.basePrices)
	// El papel urbano lo dicta el catálogo (ADR-029), no una lista local: añadir
	// un bien de consumo al seed-config lo mete en la cesta sin tocar el bot.
	for _, product := range ctx.State.CatalogProducts() {
		switch product.UrbanRole {
		case models.UrbanRoleBasket:
			s.basketProducts = append(s.basketProducts, product.ProductID)
		case models.UrbanRoleHousing:
			s.housingProduct = product.ProductID
		}
	}
	// Degradación: un servidor anterior a ADR-029 no manda `urban_role`. Se cae a
	// "toda la categoría de consumo final es cesta", que es el comportamiento
	// histórico, y se avisa (sin vivienda no habrá crecimiento).
	if len(s.basketProducts) == 0 {
		for _, product := range ctx.State.CatalogProducts() {
			if product.Category == models.CategoryFinalConsumption {
				s.basketProducts = append(s.basketProducts, product.ProductID)
			}
		}
		ctx.Logger.Warn("catálogo sin urban_role: cesta = todo el consumo final, sin vivienda",
			"basket", len(s.basketProducts))
	}

	s.p = consumerParams{
		tolerance:     SampleRange(s.rnd, 1.05, 1.4),
		spendRate:     SampleRange(s.rnd, 0.02, 0.08),
		coverage:      SampleRange(s.rnd, 3, 8),
		perTick:       consumerPerTick(s.rnd, len(s.basketProducts), ctx.Config),
		crossProb:     SampleRange(s.rnd, 0.4, 0.8),
		restingDisc:   SampleRange(s.rnd, 0.02, 0.08),
		skipTickProb:  SampleRange(s.rnd, 0.1, 0.25),
		restBudget:    int(MarketCfgFloat(ctx.Config, "rest_budget_per_tick", 4)),
		needsRefresh:  consumerNeedsRefresh(ctx.Config),
		housingShare:  consumerHousingShare(s.rnd, ctx.Config),
		housingMargin: SampleRange(s.rnd, 1.02, 1.12),
	}
	s.refreshNeeds(ctx)
	ctx.Logger.Info("ConsumerStrategy initialized",
		"priced_products", len(s.basePrices),
		"basket_products", len(s.basketProducts),
		"has_housing", s.housingProduct != "",
		"population", ctx.State.Population(),
		"tolerance", s.p.tolerance,
		"coverage_periods", s.p.coverage,
	)
	return nil
}

func consumerNeedsRefresh(cfg map[string]interface{}) time.Duration {
	if secs := ConfigFloat(cfg, "needs_refresh_seconds", 0); secs > 0 {
		return time.Duration(secs * float64(time.Second))
	}
	return consumerNeedsRefreshDefault
}

func consumerHousingShare(rnd *rand.Rand, cfg map[string]interface{}) float64 {
	if share := ConfigFloat(cfg, "housing_share", 0); share > 0 {
		return share
	}
	return SampleRange(rnd, 0.15, 0.35)
}

// SubscribedProducts implementa strategy.ProductSubscriber: la demanda final
// solo necesita el tape de lo que compra (la cesta y la vivienda).
func (s *ConsumerStrategy) SubscribedProducts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := append([]string(nil), s.basketProducts...)
	if s.housingProduct != "" {
		out = append(out, s.housingProduct)
	}
	return out
}

// refreshNeeds recarga la necesidad autoritativa del servidor. Debe llamarse con
// el mutex tomado (o desde Initialize). Un fallo NO es fatal: se conserva la
// necesidad anterior y se reintenta en el próximo tick.
func (s *ConsumerStrategy) refreshNeeds(ctx *strategy.Context) {
	if ctx.Market == nil {
		return
	}
	needs, err := ctx.Market.CityNeeds()
	if err != nil {
		// Solo se degrada la frescura: con la necesidad vieja el bot sigue
		// comprando razonablemente (la población se mueve despacio).
		ctx.Logger.Warn("fallo refrescando city-needs; se conserva la anterior", "err", err)
		return
	}
	next := make(map[string]int64, len(needs.Needs))
	for _, n := range needs.Needs {
		next[n.ProductID] = n.QtyCentPerPeriod
	}
	s.needByProduct = next
	s.needsAt = ctx.Clock.Now()
	s.needsStale = false
}

// candidato es un producto de la cesta con su hueco frente al stock objetivo.
type candidato struct {
	productID string
	faltante  int64
	cobertura float64
}

func (s *ConsumerStrategy) Tick(ctx *strategy.Context) []actions.Action {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, _, _, status := ctx.State.GetAgentInfo(); status == models.StatusBankrupt {
		return nil
	}
	if s.needsStale || ctx.Clock.Now().Sub(s.needsAt) >= s.p.needsRefresh {
		s.refreshNeeds(ctx)
	}
	if Chance(s.rnd, s.p.skipTickProb) {
		return nil
	}
	if len(s.basketProducts) == 0 {
		return nil
	}
	s.view.BeginTick(s.p.restBudget)

	capitalAvail, _ := ctx.State.Capital()
	budget := int64(float64(capitalAvail) * s.p.spendRate)
	if budget <= 0 {
		return nil
	}

	activeBuyQty := make(map[string]int64)
	for _, order := range ctx.State.ActiveOrders() {
		if order.Side == models.SideBuy {
			activeBuyQty[order.ProductID] += order.QtyPendingCent
		}
	}

	var acts []actions.Action
	// La vivienda se decide aparte y con su propia cuota de CAPITAL (no del
	// presupuesto del tick): es la inversión que hace crecer a la ciudad y, si
	// compitiera con la comida por el gasto de un tick, nunca se compraría
	// (cuesta miles de veces más). Lo que sí se descuenta del presupuesto es el
	// nocional ya comprometido, para no sobrepasar el capital en el mismo tick.
	if a, gastado, ok := s.housingAction(ctx, capitalAvail, activeBuyQty); ok {
		acts = append(acts, a)
		budget = max(0, budget-gastado)
	}

	for _, c := range s.candidatos(ctx, activeBuyQty) {
		if len(acts) >= s.p.perTick || budget <= 0 {
			break
		}
		if a, gastado, ok := s.basketAction(ctx, c, budget); ok {
			acts = append(acts, a)
			budget -= gastado
			activeBuyQty[c.productID] += a.QtyCent
		}
	}

	return acts
}

// candidatos son los productos cuyo stock (más lo ya pedido) queda por debajo
// del objetivo de cobertura, ORDENADOS por cobertura ascendente: primero lo que
// se va a agotar antes. El desempate es aleatorio para que 50 ciudades con la
// misma necesidad no golpeen el libro en el mismo orden.
func (s *ConsumerStrategy) candidatos(
	ctx *strategy.Context,
	activeBuyQty map[string]int64,
) []candidato {
	out := make([]candidato, 0, len(s.basketProducts))
	for _, pid := range s.basketProducts {
		need := s.needByProduct[pid]
		if need <= 0 {
			// Sin necesidad declarada no se compra: o el producto no está en la
			// cesta del servidor, o la población no llega a demandarlo.
			continue
		}
		objetivo := int64(float64(need) * s.p.coverage)
		tengo := ctx.State.InventoryForProduct(pid).QtyAvailableCent + activeBuyQty[pid]
		if tengo >= objetivo {
			continue
		}
		out = append(out, candidato{
			productID: pid,
			faltante:  objetivo - tengo,
			cobertura: float64(tengo) / float64(need),
		})
	}
	s.rnd.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
	sort.SliceStable(out, func(i, j int) bool { return out[i].cobertura < out[j].cobertura })
	return out
}

// basketAction construye la orden de compra de un producto de la cesta: levanta
// el mejor ask si cabe en el precio de reserva, y si no deja un bid de descanso
// bajo el fair. Devuelve la acción y el nocional que consume del presupuesto.
func (s *ConsumerStrategy) basketAction(
	ctx *strategy.Context,
	c candidato,
	budget int64,
) (actions.PlaceOrder, int64, bool) {
	fair, hasFair := s.view.Fair(c.productID)
	if !hasFair {
		return actions.PlaceOrder{}, 0, false
	}
	base := s.basePrices[c.productID]
	if base <= 0 {
		base = fair
	}
	// Ruido por producto sobre la tolerancia del bot: la disposición a pagar de
	// una persona no es idéntica para todos los bienes.
	reservation := int64(float64(base) * s.p.tolerance * SampleRange(s.rnd, 0.95, 1.05))
	if reservation < 1 {
		return actions.PlaceOrder{}, 0, false
	}

	price := int64(0)
	top := s.view.Top(ctx, c.productID)
	if top != nil && top.BestAsk != nil && top.BestAsk.PriceCents <= reservation &&
		Chance(s.rnd, s.p.crossProb) {
		// Levantar el ask: orden marketable, ejecuta contra la oferta.
		price = top.BestAsk.PriceCents
	} else {
		price = int64(float64(fair) * (1 - s.p.restingDisc))
		if price > reservation {
			price = reservation
		}
		price = NicePrice(s.rnd, price)
	}
	if price < 1 {
		return actions.PlaceOrder{}, 0, false
	}

	// La cantidad la manda el hueco, no un tamaño fijo: HumanQty solo lo
	// perturba para no cotizar todos la misma cifra redonda.
	qty := HumanQty(s.rnd, c.faltante)
	if qty > c.faltante {
		qty = c.faltante
	}
	if maxQty := MaxQtyForBudget(budget, price); qty > maxQty {
		qty = maxQty
	}
	if !IsReservable(qty, price) {
		return actions.PlaceOrder{}, 0, false
	}
	return actions.PlaceOrder{
		ProductID:       c.productID,
		Side:            models.SideBuy,
		QtyCent:         qty,
		LimitPriceCents: price,
		TTLSeconds:      TTLJitter(s.rnd),
	}, NotionalCents(qty, price), true
}

// housingAction intenta comprar UNA unidad de vivienda con la cuota de capital
// reservada a inversión. Devuelve false mientras no alcance: el ahorro es el
// mecanismo, porque una vivienda no cabe en el presupuesto de un tick.
//
// No se apila: si ya hay una orden de vivienda pendiente, no se manda otra.
func (s *ConsumerStrategy) housingAction(
	ctx *strategy.Context,
	capitalAvail int64,
	activeBuyQty map[string]int64,
) (actions.PlaceOrder, int64, bool) {
	if s.housingProduct == "" || activeBuyQty[s.housingProduct] > 0 {
		return actions.PlaceOrder{}, 0, false
	}
	fair, hasFair := s.view.Fair(s.housingProduct)
	if !hasFair {
		return actions.PlaceOrder{}, 0, false
	}
	base := s.basePrices[s.housingProduct]
	if base <= 0 {
		base = fair
	}
	reservation := int64(float64(base) * s.p.tolerance)

	price := reservation
	top := s.view.Top(ctx, s.housingProduct)
	if top != nil && top.BestAsk != nil {
		if top.BestAsk.PriceCents > reservation {
			// Demasiado cara: se sigue ahorrando en vez de pagar de más por el
			// único bien que la ciudad no puede dejar de comprar.
			return actions.PlaceOrder{}, 0, false
		}
		price = top.BestAsk.PriceCents
	}
	if price < 1 {
		return actions.PlaceOrder{}, 0, false
	}

	const unaUnidadCent = 100
	nocional := NotionalCents(unaUnidadCent, price)
	// Se compra solo con el bolsillo de inversión: así la cesta (la comida) no se
	// queda sin capital por ahorrar para construir.
	if float64(capitalAvail)*s.p.housingShare < float64(nocional)*s.p.housingMargin {
		return actions.PlaceOrder{}, 0, false
	}
	if !IsReservable(unaUnidadCent, price) {
		return actions.PlaceOrder{}, 0, false
	}
	return actions.PlaceOrder{
		ProductID:       s.housingProduct,
		Side:            models.SideBuy,
		QtyCent:         unaUnidadCent,
		LimitPriceCents: price,
		TTLSeconds:      TTLJitter(s.rnd),
	}, nocional, true
}

func (s *ConsumerStrategy) HandleEvent(ctx *strategy.Context, e events.Event) []actions.Action {
	switch ev := e.(type) {
	case events.TradePrinted:
		s.mu.Lock()
		s.view.OnTrade(ev)
		s.mu.Unlock()
	case events.CityPopulationChanged:
		// La población escala TODAS las necesidades: la vieja ya no sirve. Se marca
		// para refrescar en el próximo tick en vez de hacer I/O aquí (HandleEvent
		// corre en el dispatcher de eventos, no conviene bloquearlo con REST).
		s.mu.Lock()
		s.needsStale = true
		s.mu.Unlock()
		ctx.Logger.Info("población de la ciudad actualizada",
			"population", ev.Population,
			"ganados", ev.HabitantsGained,
			"perdidos", ev.HabitantsLost)
	case events.CityConsumed:
		// El servidor acaba de destruir parte de la despensa (el estado local ya
		// está descontado por el StateManager); el próximo tick verá el hueco.
		var unmet int64
		for _, u := range ev.Unmet {
			unmet += u.QtyCent
		}
		if unmet > 0 {
			ctx.Logger.Debug("consumo urbano con déficit", "unmet_qty_cent", unmet,
				"productos_consumidos", len(ev.Consumed))
		}
	case events.OrderExecuted:
		ctx.Logger.Debug("Consumer order executed (bien final adquirido)",
			"order_id", ev.OrderID, "product_id", ev.ProductID,
			"qty", ev.QtyExecutedCent, "price", ev.PriceCents)
	case events.BankruptcyNotice:
		ctx.Logger.Warn("Consumer bankruptcy notice received!", "agent_id", ev.AgentID)
	}
	return nil
}
