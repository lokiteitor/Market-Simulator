package botkit

import (
	"math/rand/v2"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// Helpers de humanizacion: los bots deben parecer una poblacion de operadores
// humanos heterogeneos, no clones. Dos mecanismos:
//   - Heterogeneidad: cada bot muestrea SUS parametros (spread, margen,
//     tolerancia, agresividad...) en Initialize via SampleRange/SampleIntRange.
//   - Imperfeccion: precios "bonitos" a veces (los humanos redondean),
//     cantidades perturbadas, TTLs variados, probabilidad de no actuar.

// NewStrategyRand crea el rand privado de la estrategia, sembrado desde
// ctx.Rand. Es imprescindible: ctx.Rand no es thread-safe y Tick/HandleEvent
// corren en goroutines distintas; el rand propio se usa siempre bajo el mutex
// de la estrategia. Llamar SOLO desde Initialize (unico punto single-threaded).
func NewStrategyRand(ctx *strategy.Context) *rand.Rand {
	return rand.New(rand.NewPCG(ctx.Rand.Uint64(), ctx.Rand.Uint64()))
}

// Chance devuelve true con probabilidad p.
func Chance(rnd *rand.Rand, p float64) bool {
	return rnd.Float64() < p
}

// SampleRange muestrea uniforme en [lo, hi).
func SampleRange(rnd *rand.Rand, lo, hi float64) float64 {
	return lo + rnd.Float64()*(hi-lo)
}

// SampleIntRange muestrea uniforme en [lo, hi] inclusive.
func SampleIntRange(rnd *rand.Rand, lo, hi int) int {
	if hi <= lo {
		return lo
	}
	return lo + rnd.IntN(hi-lo+1)
}

// NicePrice redondea el precio a un valor "bonito" con cierta probabilidad
// (los humanos cotizan 150, no 143). El paso de redondeo escala con la
// magnitud para no distorsionar productos baratos.
func NicePrice(rnd *rand.Rand, price int64) int64 {
	if price <= 0 {
		return price
	}
	if !Chance(rnd, 0.35) {
		return price
	}
	var step int64
	switch {
	case price < 50:
		step = 1
	case price < 200:
		step = 5
	case price < 1000:
		step = 10
	case price < 10000:
		step = 50
	default:
		step = 100
	}
	rounded := (price + step/2) / step * step
	if rounded < 1 {
		rounded = 1
	}
	return rounded
}

// HumanQty perturba una cantidad objetivo (cent-units) y la redondea a
// multiplos comodos (100 = unidades enteras). El caller debe acotar despues
// contra inventario/presupuesto reales.
func HumanQty(rnd *rand.Rand, target int64) int64 {
	if target <= 0 {
		return 0
	}
	q := int64(float64(target) * SampleRange(rnd, 0.6, 1.3))
	var step int64
	switch {
	case q >= 1000:
		step = 100
	case q >= 200:
		step = 50
	default:
		step = 10
	}
	q = q / step * step
	if q <= 0 {
		q = step
	}
	return q
}

// TTLJitter devuelve un TTL de orden variado (3-10 min); TTLs identicos en
// toda la poblacion son una firma de bot.
func TTLJitter(rnd *rand.Rand) int64 {
	return int64(SampleRange(rnd, 180, 600))
}

// Deviates indica si current se desvia de desired mas del umbral relativo.
func Deviates(current, desired int64, thresholdPct float64) bool {
	if desired <= 0 {
		return true
	}
	diff := current - desired
	if diff < 0 {
		diff = -diff
	}
	return float64(diff)/float64(desired) > thresholdPct
}

// CancelStale genera cancelaciones para las ordenes propias del producto/lado
// cuyo precio quedo lejos del deseado (cancel/replace: sin esto el libro se
// llena de precios muertos). Devuelve tambien la qty pendiente que sigue viva.
// Las reservas de las canceladas vuelven a estar disponibles en el servidor
// antes de que se ejecuten los PlaceOrder posteriores del mismo lote (el
// engine ejecuta las acciones en orden).
func CancelStale(
	orders []models.Order,
	productID string,
	side models.OrderSide,
	desired int64,
	thresholdPct float64,
) (cancels []actions.Action, liveQty int64, freedQty int64) {
	for _, o := range orders {
		if o.ProductID != productID || o.Side != side {
			continue
		}
		if Deviates(o.LimitPriceCents, desired, thresholdPct) {
			cancels = append(cancels, actions.CancelOrder{OrderID: o.OrderID})
			freedQty += o.QtyPendingCent
		} else {
			liveQty += o.QtyPendingCent
		}
	}
	return cancels, liveQty, freedQty
}

// MarketCfgFloat lee una clave numerica de la seccion `market:` del config
// (ctx.Config["market"]), con default si falta la seccion o la clave.
func MarketCfgFloat(cfg map[string]interface{}, key string, def float64) float64 {
	if cfg == nil {
		return def
	}
	section, ok := cfg["market"].(map[string]interface{})
	if !ok {
		return def
	}
	return ConfigFloat(section, key, def)
}
