package main

import (
	"strings"
)

// NewMinerStrategy crea una estrategia de productor primario especializada en minería y extracción.
func NewMinerStrategy() *PrimaryProducerStrategy {
	strat := NewPrimaryProducerStrategy()
	strat.recipeFilter = func(recipeID string) bool {
		// Las recetas de minería y extracción en infra/seed-config.json son:
		// mineria_hierro, mineria_carbon, mineria_cobre, mineria_bauxita, mineria_litio,
		// mineria_niquel, mineria_oro, mineria_plata, mineria_uranio, mineria_fosfato,
		// extraccion_arena, cantera_piedra, cantera_caliza, extraccion_arcilla, extraccion_sal,
		// pozo_petroleo, pozo_gas
		return strings.HasPrefix(recipeID, "mineria_") ||
			strings.HasPrefix(recipeID, "extraccion_") ||
			strings.HasPrefix(recipeID, "cantera_") ||
			strings.HasPrefix(recipeID, "pozo_")
	}
	return strat
}
