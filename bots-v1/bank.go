package main

import (
	"math/rand/v2"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// bankWindow cachea la política monetaria del banco central (patrón oro). La
// paridad y la banda bid/ask son FIJAS durante la corrida, así que basta un
// GET /bank en Initialize. Si la corrida no tiene patrón oro (409), la
// estrategia opera sin ventanilla (enabled=false) sin más ruido.
type bankWindow struct {
	enabled       bool
	goldProductID string
	windowBid     int64 // el banco COMPRA oro a este precio (acuña)
	windowAsk     int64 // el banco VENDE oro a este precio (destruye)
}

func loadBankWindow(ctx *strategy.Context) *bankWindow {
	if ctx.Market == nil {
		return &bankWindow{}
	}
	info, err := ctx.Market.BankInfo()
	if err != nil {
		ctx.Logger.Info("ventanilla del banco no disponible; se opera sin patrón oro", "error", err)
		return &bankWindow{}
	}
	ctx.Logger.Info("ventanilla del banco cargada",
		"gold_product_id", info.ProductID,
		"parity", info.ParityCentsPerUnit,
		"window_bid", info.WindowBidCents,
		"window_ask", info.WindowAskCents,
	)
	return &bankWindow{
		enabled:       true,
		goldProductID: info.ProductID,
		windowBid:     info.WindowBidCents,
		windowAsk:     info.WindowAskCents,
	}
}

// convertBelowMinimum: el backend rechaza conversiones cuyo nocional redondea
// a 0 centavos (mismo criterio que isReservable para órdenes).
func convertible(qtyCent, priceCents int64) bool {
	return qtyCent > 0 && priceCents > 0 && qtyCent*priceCents >= 100
}

// goldArbActions genera el arbitraje contra la ventanilla para un tick:
//
//  1. Si el mejor ASK del mercado está por debajo de windowBid×(1−margin):
//     comprar en mercado (limit marketable sobre el ask). El oro comprado se
//     monetiza en un tick posterior por la pata 2 (two-step robusto ante
//     fills parciales).
//  2. Si hay oro en inventario y windowBid supera lo que paga el mercado
//     (mejor BID de mercado, o siempre que no haya bid mejor): venderlo al
//     banco (sell_gold, dinero acuñado).
//  3. Si el mejor BID del mercado está por encima de windowAsk×(1+margin):
//     comprar oro al banco (buy_gold, síncrono) y venderlo al bid en el mismo
//     lote de acciones (el engine las ejecuta en orden).
//
// budgetCents acota el capital arriesgado por tick en las patas 1 y 3
// (con budget 0 solo corre la pata 2, que no gasta capital — el modo del
// productor que monetiza su oro minado).
func goldArbActions(
	ctx *strategy.Context,
	rnd *rand.Rand,
	view *MarketView,
	bw *bankWindow,
	margin float64,
	budgetCents int64,
) []actions.Action {
	if !bw.enabled {
		return nil
	}
	pid := bw.goldProductID
	top := view.Top(ctx, pid)
	inv := ctx.State.InventoryForProduct(pid)

	var acts []actions.Action

	// Pata 2: monetizar el oro disponible cuando la ventanilla paga mejor que
	// el mercado. Sin bid de mercado que supere windowBid, el banco es el
	// mejor comprador garantizado.
	if inv.QtyAvailableCent > 0 {
		marketPaysMore := top != nil && top.BestBid != nil && top.BestBid.PriceCents > bw.windowBid
		if !marketPaysMore && convertible(inv.QtyAvailableCent, bw.windowBid) {
			acts = append(acts, actions.ConvertGold{
				Direction: models.SellGold,
				QtyCent:   inv.QtyAvailableCent,
			})
		}
	}

	if top == nil || budgetCents <= 0 {
		return acts
	}

	// Pata 1: ask de mercado barato vs. lo que acuña el banco ⇒ comprar mercado.
	if top.BestAsk != nil {
		ask := top.BestAsk.PriceCents
		if float64(ask) <= float64(bw.windowBid)*(1-margin) {
			avail := top.BestAsk.QtyPendingCent
			if maxQty := maxQtyForBudget(budgetCents, ask); avail > maxQty {
				avail = maxQty
			}
			qty := humanQty(rnd, avail)
			if qty > avail {
				qty = avail // humanQty puede exceder el objetivo (×1.3)
			}
			if isReservable(qty, ask) {
				acts = append(acts, actions.PlaceOrder{
					ProductID:       pid,
					Side:            models.SideBuy,
					QtyCent:         qty,
					LimitPriceCents: ask, // marketable: levanta el ask
					TTLSeconds:      ttlJitter(rnd),
				})
			}
		}
	}

	// Pata 3: bid de mercado caro vs. lo que cobra el banco ⇒ buy_gold + vender
	// al bid en el mismo lote (la conversión es síncrona y precede a la orden).
	if top.BestBid != nil {
		bid := top.BestBid.PriceCents
		if float64(bid) >= float64(bw.windowAsk)*(1+margin) {
			avail := top.BestBid.QtyPendingCent
			if maxQty := maxQtyForBudget(budgetCents, bw.windowAsk); avail > maxQty {
				avail = maxQty
			}
			qty := humanQty(rnd, avail)
			if qty > avail {
				qty = avail // humanQty puede exceder el objetivo (×1.3)
			}
			if convertible(qty, bw.windowAsk) && isReservable(qty, bid) {
				acts = append(acts,
					actions.ConvertGold{Direction: models.BuyGold, QtyCent: qty},
					actions.PlaceOrder{
						ProductID:       pid,
						Side:            models.SideSell,
						QtyCent:         qty,
						LimitPriceCents: bid, // marketable: pega al bid
						TTLSeconds:      ttlJitter(rnd),
					},
				)
			}
		}
	}

	return acts
}
