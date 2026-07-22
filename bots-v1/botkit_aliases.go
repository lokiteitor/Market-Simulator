package main

// Shim de compatibilidad: la estrategia del consumidor y los helpers puros
// (humanizacion, dinero, market view, precios base) viven ahora en el package
// compartido go-sdk/sdk/botkit, para que bots-v1 y bots-ciudad usen UNA sola
// fuente de verdad. Este archivo re-exporta esos simbolos con los nombres
// locales (minuscula) que ya usan las estrategias de bots-v1, evitando tocar
// cada call site. Al tocar cualquier helper, editarlo en botkit, no aqui.

import "github.com/lokiteitor/market-simulator/sdk/botkit"

// Tipos.
type MarketView = botkit.MarketView

// Helpers de humanizacion.
var (
	newStrategyRand = botkit.NewStrategyRand
	chance          = botkit.Chance
	sampleRange     = botkit.SampleRange
	sampleIntRange  = botkit.SampleIntRange
	nicePrice       = botkit.NicePrice
	humanQty        = botkit.HumanQty
	ttlJitter       = botkit.TTLJitter
	deviates        = botkit.Deviates
	cancelStale     = botkit.CancelStale
	marketCfgFloat  = botkit.MarketCfgFloat
)

// Helpers de dinero.
var (
	notionalCents   = botkit.NotionalCents
	maxQtyForBudget = botkit.MaxQtyForBudget
	isReservable    = botkit.IsReservable
)

// Helpers de config / market view.
var (
	resolveBasePrices = botkit.ResolveBasePrices
	configFloat       = botkit.ConfigFloat
	configInt         = botkit.ConfigInt
	newMarketView     = botkit.NewMarketView
)

// La estrategia del consumidor (botkit.NewConsumerStrategy) NO se re-exporta
// aquí: desde ADR-025 la demanda final es exclusiva de las ciudades y solo la
// usa bots-ciudad.
