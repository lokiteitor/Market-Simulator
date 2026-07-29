package main

import (
	"math/rand/v2"
	"sync"
	"time"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// TraderStrategy es un market maker: cotiza bid y ask alrededor del valor
// justo vivo (MarketView) sobre un universo acotado de productos, con sesgo
// por inventario, cancel/replace de cotizaciones viejas y re-cotizacion
// debounced cuando el tape imprime. Todos los parametros se muestrean por bot
// en Initialize, asi la poblacion de traders tiene distribucion de spreads y
// agresividades en vez de un comportamiento clonado.
type TraderStrategy struct {
	mu         sync.Mutex
	rnd        *rand.Rand
	view       *MarketView
	bank       *bankWindow
	basePrices map[string]int64
	pricedPool []string
	lastQuote  map[string]quoteMark
	p          traderParams
}

type quoteMark struct {
	fair int64
	at   time.Time
}

type traderParams struct {
	halfSpread    float64       // medio-spread sobre el fair, por lado
	universeSize  int           // productos cotizados por tick
	requoteThresh float64       // desviacion relativa que dispara cancel/replace
	requoteEvery  time.Duration // debounce de re-cotizacion por evento
	reactProb     float64       // probabilidad de reaccionar a un print
	skewMax       float64       // desplazamiento maximo del mid por inventario
	invTargetCent int64         // inventario al que el skew satura
	buyTargetCent int64         // qty pendiente de compra objetivo por producto
	sellTranche   float64       // fraccion del inventario listada por tick
	actProb       float64       // probabilidad de actuar sobre un producto del universo
	skipTickProb  float64       // probabilidad de saltarse el tick entero
	capitalDen    int64         // presupuesto por producto = capital / capitalDen
	restBudget    int           // llamadas top-of-book por tick
	arbMargin     float64       // margen mínimo para arbitrar contra la ventanilla del banco
}

func NewTraderStrategy() *TraderStrategy {
	return &TraderStrategy{
		basePrices: make(map[string]int64),
		lastQuote:  make(map[string]quoteMark),
	}
}

func (s *TraderStrategy) Initialize(ctx *strategy.Context) error {
	ctx.Logger.Info("TraderStrategy initializing...")
	s.rnd = newStrategyRand(ctx)
	s.basePrices = resolveBasePrices(ctx)
	s.view = newMarketView(ctx, s.basePrices)
	s.bank = loadBankWindow(ctx)
	s.p = traderParams{
		halfSpread:    sampleRange(s.rnd, 0.015, 0.05),
		universeSize:  sampleIntRange(s.rnd, 8, 16),
		requoteThresh: sampleRange(s.rnd, 0.01, 0.03),
		requoteEvery:  time.Duration(sampleRange(s.rnd, 3, 10) * float64(time.Second)),
		reactProb:     sampleRange(s.rnd, 0.4, 0.9),
		skewMax:       sampleRange(s.rnd, 0.02, 0.05),
		invTargetCent: int64(sampleRange(s.rnd, 1500, 4000)),
		buyTargetCent: int64(sampleRange(s.rnd, 300, 800)),
		sellTranche:   sampleRange(s.rnd, 0.3, 0.7),
		actProb:       sampleRange(s.rnd, 0.8, 1.0),
		skipTickProb:  sampleRange(s.rnd, 0.05, 0.15),
		capitalDen:    int64(sampleIntRange(s.rnd, 5, 10)),
		restBudget:    int(marketCfgFloat(ctx.Config, "rest_budget_per_tick", 4)),
		arbMargin:     sampleRange(s.rnd, 0.02, 0.06),
	}
	// Pool FIJO por bot (especialización): con el tape por suscripción solo
	// llegan trades de productos declarados, así que en vez de muestrear el
	// catálogo entero cada tick, cada trader se especializa en un subconjunto
	// aleatorio ~3× su universo por tick (la población de traders cubre el
	// catálogo completo entre todos), más el oro si hay ventanilla (arb).
	full := make([]string, 0, len(s.basePrices))
	for id := range s.basePrices {
		full = append(full, id)
	}
	poolSize := s.p.universeSize * 3
	if poolSize > len(full) {
		poolSize = len(full)
	}
	s.pricedPool = make([]string, 0, poolSize+1)
	for _, i := range s.rnd.Perm(len(full))[:poolSize] {
		s.pricedPool = append(s.pricedPool, full[i])
	}
	if s.bank.enabled {
		inPool := false
		for _, id := range s.pricedPool {
			if id == s.bank.goldProductID {
				inPool = true
				break
			}
		}
		if !inPool {
			s.pricedPool = append(s.pricedPool, s.bank.goldProductID)
		}
	}
	ctx.Logger.Info("TraderStrategy initialized",
		"priced_products", len(s.basePrices),
		"tape_products", len(s.pricedPool),
		"half_spread", s.p.halfSpread,
		"universe_size", s.p.universeSize,
	)
	return nil
}

// SubscribedProducts implementa strategy.ProductSubscriber: el pool fijo del
// market maker (su especialización) es exactamente el tape que necesita.
func (s *TraderStrategy) SubscribedProducts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.pricedPool...)
}

func (s *TraderStrategy) Tick(ctx *strategy.Context) []actions.Action {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, _, _, status := ctx.State.GetAgentInfo(); status == models.StatusBankrupt {
		return nil
	}
	if chance(s.rnd, s.p.skipTickProb) {
		return nil
	}
	s.view.BeginTick(s.p.restBudget)

	// Universo: productos con mercado vivo + relleno aleatorio de los que
	// tienen precio base, mas todo lo que haya en inventario (hay que poder
	// deshacer posiciones aunque el producto salga del universo).
	universe := s.view.Universe(s.rnd, s.p.universeSize, s.pricedPool)
	inUniverse := make(map[string]bool, len(universe))
	for _, id := range universe {
		inUniverse[id] = true
	}
	for _, pos := range ctx.State.Inventory() {
		if pos.QtyAvailableCent > 0 && !inUniverse[pos.ProductID] {
			universe = append(universe, pos.ProductID)
			inUniverse[pos.ProductID] = true
		}
	}

	capitalAvail, _ := ctx.State.Capital()
	var acts []actions.Action

	// Arbitraje contra la ventanilla del banco (patrón oro): mantiene el precio
	// de mercado del oro dentro de la banda [window_bid, window_ask] (gold
	// points). Corre antes de las cotizaciones para no pisar su presupuesto.
	if s.bank.enabled {
		acts = append(acts, goldArbActions(
			ctx, s.rnd, s.view, s.bank, s.p.arbMargin, capitalAvail/s.p.capitalDen,
		)...)
	}

	for _, pid := range universe {
		if !chance(s.rnd, s.p.actProb) {
			continue
		}
		acts = append(acts, s.quoteProduct(ctx, pid, &capitalAvail)...)
	}
	return acts
}

// quoteProduct calcula bid/ask para un producto y devuelve las cancelaciones
// y colocaciones necesarias para converger a esa cotizacion. Debe llamarse
// con s.mu tomado.
func (s *TraderStrategy) quoteProduct(ctx *strategy.Context, pid string, capital *int64) []actions.Action {
	fair, ok := s.view.Fair(pid)
	if !ok {
		return nil
	}
	top := s.view.Top(ctx, pid)
	inv := ctx.State.InventoryForProduct(pid)

	// Sesgo por inventario: largo -> baja ambas puntas para rotar posicion.
	skew := 0.0
	if s.p.invTargetCent > 0 {
		ratio := float64(inv.QtyAvailableCent+inv.QtyReservedCent) / float64(s.p.invTargetCent)
		if ratio > 1 {
			ratio = 1
		}
		skew = -s.p.skewMax * ratio
	}
	mid := float64(fair) * (1 + skew)
	bid := int64(mid * (1 - s.p.halfSpread))
	ask := int64(mid * (1 + s.p.halfSpread))

	// No cruzar el libro: el market maker provee liquidez, no la toma.
	if top != nil {
		if top.BestAsk != nil && bid >= top.BestAsk.PriceCents {
			bid = top.BestAsk.PriceCents - 1
		}
		if top.BestBid != nil && ask <= top.BestBid.PriceCents {
			ask = top.BestBid.PriceCents + 1
		}
	}
	bid = nicePrice(s.rnd, bid)
	ask = nicePrice(s.rnd, ask)
	if bid < 1 {
		bid = 1
	}
	if ask <= bid {
		ask = bid + 1
	}

	orders := ctx.State.ActiveOrders()
	cancelBuys, liveBuy, _ := cancelStale(orders, pid, models.SideBuy, bid, s.p.requoteThresh)
	cancelSells, _, _ := cancelStale(orders, pid, models.SideSell, ask, s.p.requoteThresh)

	var acts []actions.Action
	acts = append(acts, cancelBuys...)
	acts = append(acts, cancelSells...)

	// Punta de compra: reponer hasta el objetivo pendiente.
	if liveBuy < s.p.buyTargetCent {
		qty := humanQty(s.rnd, s.p.buyTargetCent-liveBuy)
		budget := *capital / s.p.capitalDen
		if maxQty := maxQtyForBudget(budget, bid); qty > maxQty {
			qty = maxQty
		}
		if isReservable(qty, bid) {
			acts = append(acts, actions.PlaceOrder{
				ProductID:       pid,
				Side:            models.SideBuy,
				QtyCent:         qty,
				LimitPriceCents: bid,
				TTLSeconds:      ttlJitter(s.rnd),
			})
			*capital -= notionalCents(qty, bid)
		}
	}

	// Punta de venta: una tranche del inventario vendible. Solo lo disponible
	// ahora; NO se suma lo que liberarian los cancelSells de este mismo lote (el
	// cancel puede fallar o el pending local venir inflado por un fill aun no
	// procesado -> insufficient_inventory). Lo liberado se re-lista al proximo
	// tick, ya devuelto a disponible por el order_cancelled.
	sellable := inv.QtyAvailableCent
	if sellable > 0 {
		qty := humanQty(s.rnd, int64(float64(sellable)*s.p.sellTranche))
		if qty > sellable {
			qty = sellable
		}
		if isReservable(qty, ask) {
			acts = append(acts, actions.PlaceOrder{
				ProductID:       pid,
				Side:            models.SideSell,
				QtyCent:         qty,
				LimitPriceCents: ask,
				TTLSeconds:      ttlJitter(s.rnd),
			})
		}
	}

	s.lastQuote[pid] = quoteMark{fair: fair, at: ctx.Clock.Now()}
	return acts
}

func (s *TraderStrategy) HandleEvent(ctx *strategy.Context, e events.Event) []actions.Action {
	switch ev := e.(type) {
	case events.TradePrinted:
		s.mu.Lock()
		defer s.mu.Unlock()
		s.view.OnTrade(ev)

		// Re-cotizacion event-driven, con debounce y probabilidad: reaccionar
		// a cada print al instante es una firma de bot (y una estampida con
		// miles de agentes); no reaccionar nunca es un libro muerto.
		mark, quoting := s.lastQuote[ev.ProductID]
		if !quoting {
			return nil
		}
		if ctx.Clock.Now().Sub(mark.at) < s.p.requoteEvery {
			return nil
		}
		fair, ok := s.view.Fair(ev.ProductID)
		if !ok || !deviates(fair, mark.fair, s.p.requoteThresh) {
			return nil
		}
		if !chance(s.rnd, s.p.reactProb) {
			return nil
		}
		capitalAvail, _ := ctx.State.Capital()
		return s.quoteProduct(ctx, ev.ProductID, &capitalAvail)

	case events.OrderExecuted:
		ctx.Logger.Debug("Trader order executed", "order_id", ev.OrderID, "product_id", ev.ProductID, "qty", ev.QtyExecutedCent, "price", ev.PriceCents)
	case events.BankruptcyNotice:
		ctx.Logger.Warn("Trader bankruptcy notice received!", "agent_id", ev.AgentID)
	}
	return nil
}
