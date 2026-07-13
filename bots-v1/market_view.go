package main

import (
	"math/rand/v2"
	"sort"
	"sync"
	"time"

	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// MarketView mantiene, por producto, una estimacion viva del "valor justo":
// una EMA de los precios del tape (trade_printed) sembrada con el precio base
// del config.yaml y acotada a una banda alrededor de el. La banda es el
// guardarrail anti-fuga: sin ella, los bots comerciando entre si realimentan
// la EMA (trade caro -> fair mas alto -> cotizaciones mas caras -> trade mas
// caro) y el precio se escapa de la economia configurada.
//
// Complementa la EMA con un cache de top-of-book con presupuesto de llamadas
// REST por tick: con miles de bots, el polling sin racionar tumba al servidor.
//
// Thread-safety: Tick y HandleEvent corren en goroutines distintas del engine
// (scheduler y dispatcher), asi que todos los metodos toman el lock interno.
type MarketView struct {
	mu sync.Mutex

	alpha          float64
	bandLo, bandHi float64
	topTTL         time.Duration
	recentWindow   time.Duration
	nowFn          func() time.Time

	fair        map[string]float64 // productID -> EMA (cents/unidad)
	anchor      map[string]float64 // productID -> precio base (limites de la banda)
	lastTradeAt map[string]time.Time

	tops       map[string]cachedTop
	restBudget int
}

type cachedTop struct {
	top *models.TopOfBook
	at  time.Time
}

func newMarketView(ctx *strategy.Context, basePrices map[string]int64) *MarketView {
	v := &MarketView{
		alpha:        marketCfgFloat(ctx.Config, "ema_alpha", 0.25),
		bandLo:       marketCfgFloat(ctx.Config, "fair_band_lo", 0.4),
		bandHi:       marketCfgFloat(ctx.Config, "fair_band_hi", 2.5),
		topTTL:       time.Duration(marketCfgFloat(ctx.Config, "top_ttl_seconds", 12)) * time.Second,
		recentWindow: time.Duration(marketCfgFloat(ctx.Config, "recent_window_seconds", 600)) * time.Second,
		nowFn:        ctx.Clock.Now,
		fair:         make(map[string]float64),
		anchor:       make(map[string]float64),
		lastTradeAt:  make(map[string]time.Time),
		tops:         make(map[string]cachedTop),
	}
	for id, p := range basePrices {
		v.fair[id] = float64(p)
		v.anchor[id] = float64(p)
	}
	return v
}

// OnTrade actualiza la EMA con un print del tape (propio o ajeno). Para
// productos sin precio base, el primer trade fija el anchor de la banda.
func (v *MarketView) OnTrade(ev events.TradePrinted) {
	if ev.PriceCents <= 0 {
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	price := float64(ev.PriceCents)
	prev, ok := v.fair[ev.ProductID]
	if !ok {
		v.fair[ev.ProductID] = price
		v.anchor[ev.ProductID] = price
	} else {
		next := v.alpha*price + (1-v.alpha)*prev
		if a := v.anchor[ev.ProductID]; a > 0 {
			if next < a*v.bandLo {
				next = a * v.bandLo
			}
			if next > a*v.bandHi {
				next = a * v.bandHi
			}
		}
		v.fair[ev.ProductID] = next
	}
	v.lastTradeAt[ev.ProductID] = v.nowFn()
}

// Fair devuelve el valor justo estimado en cents/unidad. false si no hay ni
// trades observados ni precio base para el producto.
func (v *MarketView) Fair(productID string) (int64, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	f, ok := v.fair[productID]
	if !ok || f < 1 {
		return 0, false
	}
	return int64(f + 0.5), true
}

// BeginTick repone el presupuesto de llamadas REST para este tick.
func (v *MarketView) BeginTick(budget int) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.restBudget = budget
}

// Top devuelve el top-of-book del producto: el cache si esta fresco, un fetch
// REST si queda presupuesto, y el cache viejo (o nil) como ultimo recurso.
// Cotizar contra un top ligeramente viejo es seguro: las ordenes son limit,
// asi que cruzar sin saberlo solo ejecuta a mejor precio.
func (v *MarketView) Top(ctx *strategy.Context, productID string) *models.TopOfBook {
	v.mu.Lock()
	defer v.mu.Unlock()
	c, cached := v.tops[productID]
	now := v.nowFn()
	if cached && now.Sub(c.at) < v.topTTL {
		return c.top
	}
	if ctx.Market == nil || v.restBudget <= 0 {
		if cached {
			return c.top
		}
		return nil
	}
	v.restBudget--
	top, err := ctx.Market.TopOfBook(productID)
	if err != nil {
		ctx.Logger.Debug("fallo consultando top-of-book", "product_id", productID, "error", err)
		if cached {
			return c.top
		}
		return nil
	}
	v.tops[productID] = cachedTop{top: top, at: now}
	return top
}

// Universe arma el universo activo del bot: primero los productos con trades
// recientes (mercado vivo, mas recientes primero), completado con picks
// aleatorios del pool para bootstrapear liquidez cuando el mercado arranca
// frio o un producto lleva tiempo sin imprimir.
func (v *MarketView) Universe(rnd *rand.Rand, n int, pool []string) []string {
	if n <= 0 {
		return nil
	}
	type recentTrade struct {
		id string
		at time.Time
	}
	v.mu.Lock()
	now := v.nowFn()
	recent := make([]recentTrade, 0, len(v.lastTradeAt))
	for id, at := range v.lastTradeAt {
		if now.Sub(at) <= v.recentWindow {
			recent = append(recent, recentTrade{id: id, at: at})
		}
	}
	v.mu.Unlock()

	sort.Slice(recent, func(i, j int) bool { return recent[i].at.After(recent[j].at) })
	out := make([]string, 0, n)
	seen := make(map[string]bool, n)
	for _, r := range recent {
		if len(out) >= n {
			break
		}
		out = append(out, r.id)
		seen[r.id] = true
	}
	if len(out) < n && len(pool) > 0 {
		for _, i := range rnd.Perm(len(pool)) {
			if len(out) >= n {
				break
			}
			if id := pool[i]; !seen[id] {
				out = append(out, id)
				seen[id] = true
			}
		}
	}
	return out
}
