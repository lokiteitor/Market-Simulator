package main

import (
	"strings"
)

// NewFarmerStrategy crea una estrategia de productor primario especializada en cultivos, ganadería y otros recursos naturales.
func NewFarmerStrategy() *PrimaryProducerStrategy {
	strat := NewPrimaryProducerStrategy()
	strat.recipeFilter = func(recipeID string) bool {
		// Las recetas agrícolas y ganaderas en infra/seed-config.json son:
		// cultivo_trigo, cultivo_maiz, cultivo_tomate, cultivo_soya, cultivo_algodon, cultivo_cana, cultivo_cafe, cultivo_cacao,
		// cosecha_frutas, cosecha_verduras,
		// cria_bovino, cria_cerdos, cria_pollos,
		// ordena, germinado_rapido, captacion_agua, tala, esquila
		return strings.HasPrefix(recipeID, "cultivo_") ||
			strings.HasPrefix(recipeID, "cosecha_") ||
			strings.HasPrefix(recipeID, "cria_") ||
			recipeID == "ordena" ||
			recipeID == "germinado_rapido" ||
			recipeID == "captacion_agua" ||
			recipeID == "tala" ||
			recipeID == "esquila"
	}
	return strat
}
