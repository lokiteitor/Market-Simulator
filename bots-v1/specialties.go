package main

// Especialidades del productor (ADR-022).
//
// Con un único rol productivo, lo que reparte el catálogo entre bots ya no es
// el rol sino el TIPO DE INSTALACIÓN que cada uno está dispuesto a comprar.
// Los cuatro conjuntos de abajo particionan los 16 tipos del seed-config:
// juntos lo cubren todo y no se solapan, así que el enjambre cubre la cadena
// entera sin que ningún bot intente abarcar los 156 procesos.
//
// El aguador existe como especialidad propia porque el agua es la RAÍZ del
// catálogo: la consumen 36 recetas y solo dos la producen. Si nadie se dedica
// a bombear, la economía entera se queda parada en el primer eslabón.
var (
	tiposAgua       = tipos("pozo_agua")
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
