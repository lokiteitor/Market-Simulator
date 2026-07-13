package main

import (
	"math/rand/v2"
	"sync"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// ConsumerStrategy es la demanda final del mercado, con elasticidad: cada bot
// tiene un precio de reserva (base * tolerancia, anclado al precio base y NO
// al fair, para que la demanda no persiga al precio hacia arriba) y una tasa
// de gasto por tick. Si el mejor ask cabe en la reserva, lo LEVANTA (orden
// marketable que imprime un trade real); si no, deja un bid de descanso bajo
// el fair. Los consumers son quienes imprimen la mayoria del tape que
// alimenta las EMAs del resto de la poblacion.
type ConsumerStrategy struct {
	mu            sync.Mutex
	rnd           *rand.Rand
	view          *MarketView
	basePrices    map[string]int64
	finalProducts []string
	p             consumerParams
}

type consumerParams struct {
	tolerance     float64 // reserva = base * tolerance
	spendRate     float64 // fraccion del capital disponible gastable por tick
	perTick       int     // productos considerados por tick
	crossProb     float64 // probabilidad de levantar un ask asequible
	buyTargetCent int64   // qty objetivo por compra
	restingDisc   float64 // descuento del bid de descanso vs fair
	pendingCap    int64   // techo de qty pendiente de compra por producto
	skipTickProb  float64
	restBudget    int
}

func NewConsumerStrategy() *ConsumerStrategy {
	return &ConsumerStrategy{
		basePrices: make(map[string]int64),
	}
}

func (s *ConsumerStrategy) Initialize(ctx *strategy.Context) error {
	ctx.Logger.Info("ConsumerStrategy initializing...")
	s.rnd = newStrategyRand(ctx)
	s.basePrices = resolveBasePrices(ctx)
	s.view = newMarketView(ctx, s.basePrices)
	for _, product := range ctx.State.CatalogProducts() {
		if product.Category == models.CategoryFinalConsumption {
			s.finalProducts = append(s.finalProducts, product.ProductID)
		}
	}
	s.p = consumerParams{
		tolerance:     sampleRange(s.rnd, 1.05, 1.4),
		spendRate:     sampleRange(s.rnd, 0.02, 0.08),
		perTick:       sampleIntRange(s.rnd, 3, 8),
		crossProb:     sampleRange(s.rnd, 0.4, 0.8),
		buyTargetCent: int64(sampleRange(s.rnd, 200, 600)),
		restingDisc:   sampleRange(s.rnd, 0.02, 0.08),
		pendingCap:    int64(sampleRange(s.rnd, 800, 1500)),
		skipTickProb:  sampleRange(s.rnd, 0.1, 0.25),
		restBudget:    int(marketCfgFloat(ctx.Config, "rest_budget_per_tick", 4)),
	}
	ctx.Logger.Info("ConsumerStrategy initialized",
		"priced_products", len(s.basePrices),
		"final_products", len(s.finalProducts),
		"tolerance", s.p.tolerance,
	)
	return nil
}

func (s *ConsumerStrategy) Tick(ctx *strategy.Context) []actions.Action {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, _, _, status := ctx.State.GetAgentInfo(); status == models.StatusBankrupt {
		return nil
	}
	if chance(s.rnd, s.p.skipTickProb) {
		return nil
	}
	if len(s.finalProducts) == 0 {
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
	considered := 0
	for _, i := range s.rnd.Perm(len(s.finalProducts)) {
		if considered >= s.p.perTick || budget <= 0 {
			break
		}
		considered++
		pid := s.finalProducts[i]

		fair, hasFair := s.view.Fair(pid)
		if !hasFair {
			continue
		}
		base := s.basePrices[pid]
		if base <= 0 {
			base = fair
		}
		// Ruido por producto sobre la tolerancia del bot: la disposicion a
		// pagar de una persona no es identica para todos los bienes.
		reservation := int64(float64(base) * s.p.tolerance * sampleRange(s.rnd, 0.95, 1.05))
		if reservation < 1 {
			continue
		}

		top := s.view.Top(ctx, pid)
		if top != nil && top.BestAsk != nil && top.BestAsk.PriceCents <= reservation && chance(s.rnd, s.p.crossProb) {
			// Levantar el ask: orden marketable, ejecuta contra la oferta.
			price := top.BestAsk.PriceCents
			qty := humanQty(s.rnd, s.p.buyTargetCent)
			if maxQty := maxQtyForBudget(budget, price); qty > maxQty {
				qty = maxQty
			}
			if isReservable(qty, price) {
				acts = append(acts, actions.PlaceOrder{
					ProductID:       pid,
					Side:            models.SideBuy,
					QtyCent:         qty,
					LimitPriceCents: price,
					TTLSeconds:      ttlJitter(s.rnd),
				})
				budget -= notionalCents(qty, price)
				activeBuyQty[pid] += qty
			}
			continue
		}

		// Bid de descanso bajo el fair, sin exceder la reserva ni el techo de
		// pendientes del producto.
		if activeBuyQty[pid] >= s.p.pendingCap {
			continue
		}
		price := int64(float64(fair) * (1 - s.p.restingDisc))
		if price > reservation {
			price = reservation
		}
		price = nicePrice(s.rnd, price)
		if price < 1 {
			continue
		}
		qty := humanQty(s.rnd, s.p.buyTargetCent)
		if room := s.p.pendingCap - activeBuyQty[pid]; qty > room {
			qty = room
		}
		if maxQty := maxQtyForBudget(budget, price); qty > maxQty {
			qty = maxQty
		}
		if isReservable(qty, price) {
			acts = append(acts, actions.PlaceOrder{
				ProductID:       pid,
				Side:            models.SideBuy,
				QtyCent:         qty,
				LimitPriceCents: price,
				TTLSeconds:      ttlJitter(s.rnd),
			})
			budget -= notionalCents(qty, price)
			activeBuyQty[pid] += qty
		}
	}

	return acts
}

func (s *ConsumerStrategy) HandleEvent(ctx *strategy.Context, e events.Event) []actions.Action {
	switch ev := e.(type) {
	case events.TradePrinted:
		s.mu.Lock()
		s.view.OnTrade(ev)
		s.mu.Unlock()
	case events.OrderExecuted:
		ctx.Logger.Debug("Consumer order executed (consumed final product)", "order_id", ev.OrderID, "product_id", ev.ProductID, "qty", ev.QtyExecutedCent, "price", ev.PriceCents)
	case events.BankruptcyNotice:
		ctx.Logger.Warn("Consumer bankruptcy notice received!", "agent_id", ev.AgentID)
	}
	return nil
}
