package main

import (
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// resolveBasePrices convierte la tabla `prices` del config.yaml (clave =
// product key del catalogo, ej. "trigo") en un mapa por ProductID, resolviendo
// cada key contra el catalogo ya descargado (SetCatalog corre antes de
// Initialize). Las estrategias consultan por ProductID en el tick, asi que
// este es el unico punto de traduccion key→UUID.
//
// Devuelve tambien avisos: keys del YAML sin producto en el catalogo (typos o
// catalogo desactualizado) y productos del catalogo sin precio configurado
// (cotizaran con el fallback de cada estrategia).
func resolveBasePrices(ctx *strategy.Context) map[string]int64 {
	configured := make(map[string]int64)
	if pricesRaw, ok := ctx.Config["prices"]; ok {
		if pricesMap, ok := pricesRaw.(map[string]interface{}); ok {
			for k, v := range pricesMap {
				switch val := v.(type) {
				case int:
					configured[k] = int64(val)
				case int64:
					configured[k] = val
				case float64:
					configured[k] = int64(val)
				}
			}
		}
	}

	byProductID := make(map[string]int64, len(configured))
	var unknownKeys []string
	for key, price := range configured {
		product, ok := ctx.State.ProductByKey(key)
		if !ok {
			unknownKeys = append(unknownKeys, key)
			continue
		}
		byProductID[product.ProductID] = price
	}

	var unpriced []string
	for _, product := range ctx.State.CatalogProducts() {
		if _, ok := byProductID[product.ProductID]; !ok {
			unpriced = append(unpriced, product.Key)
		}
	}

	if len(unknownKeys) > 0 {
		ctx.Logger.Warn("precios configurados sin producto en el catalogo", "keys", unknownKeys)
	}
	if len(unpriced) > 0 {
		ctx.Logger.Warn("productos del catalogo sin precio base configurado", "count", len(unpriced), "keys", unpriced)
	}
	ctx.Logger.Info("precios base resueltos contra el catalogo", "resolved", len(byProductID), "configured", len(configured))
	return byProductID
}

// configFloat lee una clave numerica del mapa de configuracion de estrategia,
// tolerando los tipos que produce YAML/Go (int, int64, float64). Devuelve def
// si la clave no existe o no es numerica.
func configFloat(cfg map[string]interface{}, key string, def float64) float64 {
	v, ok := cfg[key]
	if !ok {
		return def
	}
	switch val := v.(type) {
	case float64:
		return val
	case int:
		return float64(val)
	case int64:
		return float64(val)
	default:
		return def
	}
}

// configInt es el equivalente entero de configFloat.
func configInt(cfg map[string]interface{}, key string, def int) int {
	v, ok := cfg[key]
	if !ok {
		return def
	}
	switch val := v.(type) {
	case int:
		return val
	case int64:
		return int(val)
	case float64:
		return int(val)
	default:
		return def
	}
}
