package main

import (
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// Especialidades del productor (ADR-022).
//
// Con un único rol productivo, lo que reparte el catálogo entre bots ya no es
// el rol sino el TIPO DE INSTALACIÓN que cada uno está dispuesto a comprar.
// Los cinco conjuntos de abajo particionan los 17 tipos del seed-config:
// juntos lo cubren todo y no se solapan, así que el enjambre cubre la cadena
// entera sin que ningún bot intente abarcar los 152 procesos.
//
// El aguador existe como especialidad propia porque el agua es la RAÍZ del
// catálogo: la consumen 36 recetas y solo dos la producen. Si nadie se dedica
// a bombear, la economía entera se queda parada en el primer eslabón. El
// energético (ADR-024) es el mismo razonamiento un eslabón más arriba: la
// electricidad es insumo de toda la industria y solo la produce `generacion`.
var (
	tiposAgua       = tipos("pozo_agua")
	tiposEnergia    = tipos("generacion")
	tiposAgro       = tipos("campo", "granja", "bosque")
	tiposExtractivo = tipos("mina", "cantera", "pozo")
	tiposIndustria  = tipos(
		"agroindustria", "metalurgia", "materiales", "refineria", "aserradero",
		"electronica", "componentes", "ensamblaje", "construccion",
	)
)

func tipos(keys ...string) map[string]bool {
	out := make(map[string]bool, len(keys))
	for _, k := range keys {
		out[k] = true
	}
	return out
}

// NewAguadorStrategy: pozos de agua. La raíz de la cadena.
func NewAguadorStrategy() *ProducerStrategy {
	s := NewProducerStrategy()
	s.typeFilter = tiposAgua
	// El agua es insumo universal: conviene que escale más que el resto.
	s.maxDesiredLevel = 5
	return s
}

// NewEnergeticoStrategy: generación eléctrica. La electricidad es insumo de
// las 113 recetas industriales: sin centrales, la industria entera se para.
func NewEnergeticoStrategy() *ProducerStrategy {
	s := NewProducerStrategy()
	s.typeFilter = tiposEnergia
	// Insumo casi universal: conviene que escale más que el resto.
	s.maxDesiredLevel = 4
	s.recipePriority = prioridadRenovablePrimero
	return s
}

// prioridadRenovablePrimero: la hidroeléctrica antes que las térmicas.
//
// Las tres recetas de `generacion` comparten el mismo presupuesto de
// concurrencia —el nivel de la instalación (ADR-021)—, así que con nivel 1 solo
// corre una y el orden decide cuál. La hidro es la única que cuelga solo del
// agua, la raíz del catálogo (ADR-022); las térmicas queman carbón o gas
// natural, recursos de yacimiento finito (ADR-023) que alguien tiene que estar
// minando ya. Al arrancar el mundo desde inventario cero no hay ni carbón ni gas
// en el libro: el energético repartía su capital entre los tres insumos, se
// quedaba con bids de carbón y de gas que nadie surte, sin agua para la hidro y
// sin producir un solo kWh. Con la hidro primero, el único insumo que compra es
// el que el aguador sí vende.
//
// No es un parche de arranque: cuando el carbón escasee de verdad, su
// rendimiento decreciente lo encarecerá hasta que la hidro sea la marginal —
// que es la transición energética que describe ADR-024. Priorizar lo renovable
// es apostar por el lado del que la escasez no puede echarte.
func prioridadRenovablePrimero(ctx *strategy.Context, r models.Recipe) int {
	for _, input := range r.Inputs {
		if _, finito := ctx.State.Deposit(input.ProductID); finito {
			return 1 // térmica: depende de un yacimiento que se agota
		}
	}
	return 0 // hidro: solo agua
}

// NewFarmerStrategy: cultivo, ganadería y bosque (campo, granja, bosque).
func NewFarmerStrategy() *ProducerStrategy {
	s := NewProducerStrategy()
	s.typeFilter = tiposAgro
	return s
}

// NewMinerStrategy: minería y extracción (mina, cantera, pozo).
func NewMinerStrategy() *ProducerStrategy {
	s := NewProducerStrategy()
	s.typeFilter = tiposExtractivo
	return s
}

// NewTransformerStrategy: industria (de la agroindustria a la constructora).
func NewTransformerStrategy() *ProducerStrategy {
	s := NewProducerStrategy()
	s.typeFilter = tiposIndustria
	return s
}
