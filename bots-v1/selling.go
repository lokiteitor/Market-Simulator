package main

import (
	"math/rand/v2"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// sellParams parametriza la venta a mercado; los valores vienen muestreados
// por bot (heterogeneidad de la poblacion).
type sellParams struct {
	minMargin     float64 // margen minimo sobre coste (suelo)
	targetMargin  float64 // margen objetivo sobre fair cuando no hay ask que mejorar
	undercut      float64 // rebaja relativa sobre el mejor ask
	tranche       float64 // fraccion del inventario listada por llamada
	requoteThresh float64 // desviacion que dispara cancel/replace
	liqCap        float64 // techo del suelo relativo al fair (modo liquidacion)
}

// sellAtMarket lista una tranche del inventario del producto a precio de
// mercado: undercut del mejor ask, con suelo de coste. Si el coste queda muy
// por encima del fair (producto sobrecosteado), el suelo se recorta a
// fair*liqCap: liquidar despacio en vez de descansar en un ask que jamas
// cruzara nadie (la parada de produccion corta el reabastecimiento).
// costPU <= 0 significa coste desconocido: se vende solo contra el fair.
func sellAtMarket(
	ctx *strategy.Context,
	rnd *rand.Rand,
	view *MarketView,
	pos models.InventoryPosition,
	costPU int64,
	p sellParams,
) []actions.Action {
	fair, hasFair := view.Fair(pos.ProductID)
	var desired int64
	if hasFair {
		desired = int64(float64(fair) * (1 + p.targetMargin))
	} else if costPU > 0 {
		// Sin referencia de mercado ni base: cotizar desde coste.
		fair = int64(float64(costPU) * (1 + p.targetMargin))
		desired = fair
	} else {
		return nil
	}

	if top := view.Top(ctx, pos.ProductID); top != nil && top.BestAsk != nil {
		under := int64(float64(top.BestAsk.PriceCents) * (1 - p.undercut))
		if under < desired {
			desired = under
		}
	}
	if costPU > 0 {
		floor := int64(float64(costPU) * (1 + p.minMargin))
		if liq := int64(float64(fair) * p.liqCap); floor > liq {
			floor = liq
		}
		if desired < floor {
			desired = floor
		}
	}

	price := nicePrice(rnd, desired)
	if price < 1 {
		return nil
	}

	cancels, _, _ := cancelStale(ctx.State.ActiveOrders(), pos.ProductID, models.SideSell, price, p.requoteThresh)
	acts := cancels
	// Vendible = SOLO lo disponible ahora. NO se suma la qty que liberarian las
	// cancelaciones de este mismo lote: el cancel puede fallar en el servidor
	// (la orden ya se cruzo/expiro) o el QtyPendingCent local venir inflado (un
	// fill parcial cuyo order_executed aun no procesamos, WS es otra goroutine),
	// y entonces el servidor libera menos de lo previsto -> la venta reventaria
	// con insufficient_inventory. Lo liberado se re-lista en el proximo tick, ya
	// devuelto a disponible por el order_cancelled (optimista local + servidor).
	sellable := pos.QtyAvailableCent
	if sellable <= 0 {
		return acts
	}
	qty := humanQty(rnd, int64(float64(sellable)*p.tranche))
	if qty > sellable {
		qty = sellable
	}
	if !isReservable(qty, price) {
		return acts
	}
	return append(acts, actions.PlaceOrder{
		ProductID:       pos.ProductID,
		Side:            models.SideSell,
		QtyCent:         qty,
		LimitPriceCents: price,
		TTLSeconds:      ttlJitter(rnd),
	})
}
