package main

import (
	"math/rand/v2"

	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// Adaptación lenta de los parámetros de precio (ADR-027).
//
// En bots-v1 cada bot muestrea sus márgenes en `Initialize` y no los cambia
// jamás: un bot al que le tocó `minMargin` 0,19 en un mercado donde el resto
// vende al 0,06 no vende NADA en toda la corrida, y no se entera nunca. La
// población es heterogénea, pero muerta.
//
// La señal que se usa aquí es la ACUMULACIÓN DE STOCK, no la tasa de fill de
// órdenes concretas: `events.OrderExecuted` no trae el lado y el estado local ya
// ha borrado la orden completada cuando la estrategia ve el evento, así que
// contar fills desde la estrategia es frágil. El inventario, en cambio, es
// observable y dice justo lo que hace falta saber: si el stock de lo que
// producimos crece ventana tras ventana mientras tenemos asks vivos, el precio
// que pedimos es demasiado alto.
//
// Es deliberadamente lento (ventanas de decenas de ticks y pasos de ±8%): esto
// no es un optimizador, es evitar que un bot se quede fuera del mercado para
// siempre por un sorteo inicial. Los topes acotan la deriva para que la
// población no converja a un solo comportamiento (que es justo lo que la
// heterogeneidad de v1 buscaba evitar).
type adaptacion struct {
	ventana      int // ticks por ventana de evaluación
	transcurrido int
	stockPrevio  int64
	// Topes de la deriva, muestreados por bot alrededor de su valor inicial.
	minMarginPiso, minMarginTecho float64
	undercutPiso, undercutTecho   float64
	// Ticks consecutivos sin arrancar ni una ejecución rentable (para el pivote).
	ticksSinProducir int
}

func (a *adaptacion) init(rnd *rand.Rand, p producerParams) {
	a.ventana = sampleIntRange(rnd, 30, 60)
	a.stockPrevio = -1
	// La deriva permitida es amplia hacia abajo (hay que poder llegar a vender)
	// y estrecha hacia arriba (subir el margen sin límite es dejar de vender por
	// otro camino).
	a.minMarginPiso = 0.01
	a.minMarginTecho = p.minMargin * 1.8
	a.undercutPiso = 0.005
	a.undercutTecho = 0.08
}

// adaptar corre al final de cada tick y ajusta el margen y el undercut una vez
// por ventana, comparando el stock de los productos que el bot produce con el
// de la ventana anterior.
func (s *ProducerStrategy) adaptar(ctx *strategy.Context, recipeByOutput map[string]models.Recipe) {
	a := &s.ad
	a.transcurrido++
	if a.transcurrido < a.ventana {
		return
	}
	a.transcurrido = 0

	var stock int64
	for _, pos := range ctx.State.Inventory() {
		if _, esOutput := recipeByOutput[pos.ProductID]; esOutput {
			stock += pos.QtyAvailableCent
		}
	}
	previo := a.stockPrevio
	a.stockPrevio = stock
	if previo < 0 {
		return // primera ventana: solo se toma la referencia
	}

	// ¿Tenemos oferta viva? Sin asks en el libro, que el stock crezca no dice
	// nada del precio: dice que no estamos vendiendo.
	conAsks := false
	for _, o := range ctx.State.ActiveOrders() {
		if o.Side == models.SideSell {
			conAsks = true
			break
		}
	}
	if !conAsks {
		return
	}

	switch {
	case stock > previo:
		// Acumulando con oferta viva: nadie nos compra. Bajar el suelo y
		// morder más al mejor ask.
		s.p.minMargin = acotar(s.p.minMargin*0.92, a.minMarginPiso, a.minMarginTecho)
		s.p.undercut = acotar(s.p.undercut*1.15, a.undercutPiso, a.undercutTecho)
		ctx.Logger.Debug("adaptación: stock acumulándose, bajando margen",
			"oficio", s.oficio.Key, "min_margin", s.p.minMargin, "undercut", s.p.undercut)
	case stock == 0 && previo > 0:
		// Se vendió todo lo que había: hay sitio para pedir algo más.
		s.p.minMargin = acotar(s.p.minMargin*1.06, a.minMarginPiso, a.minMarginTecho)
		ctx.Logger.Debug("adaptación: stock colocado, subiendo margen",
			"oficio", s.oficio.Key, "min_margin", s.p.minMargin)
	}
}

func acotar(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// -----------------------------------------------------------------------------
// Pivote de oficio
// -----------------------------------------------------------------------------

// pivoteTicksSinProducir: ticks consecutivos sin arrancar ni una ejecución
// rentable antes de plantearse cambiar de oficio. Con `tick_interval` 5 s son
// unos 10 minutos reales.
const pivoteTicksSinProducir = 120

// evaluarPivote decide si el bot cambia de oficio y lo hace. Devuelve true si
// pivotó (el tick se descarta: sus acciones son del nicho viejo).
//
// El motivo es ADR-026 llevado a su conclusión: la quiebra retira al bot para
// SIEMPRE, así que una flota solo puede encoger. Un bot cuyo nicho no da de
// comer —porque su producto no tiene demanda, porque el yacimiento del que
// depende se agotó, o simplemente porque sobran productores— tiene una
// alternativa mejor que esperar sentado a arruinarse: dedicarse a otra cosa.
//
// Solo pivota a oficios que comparten un TIPO DE INSTALACIÓN que ya tiene
// pagado. Es la restricción que hace que esto no sea un capricho: la instalación
// es coste hundido (ADR-021) y cambiar dentro de ella no cuesta un centavo,
// mientras que pivotar a otro tipo exigiría comprar la instalación entera justo
// cuando al bot no le sobra el capital. En la práctica es lo que drena los
// oficios `sin_demanda`: el refinador de combustibles acaba en petroquímica o
// fertilizantes, que comparten el tipo `refineria`.
func (s *ProducerStrategy) evaluarPivote(ctx *strategy.Context, produjo, huboMargen bool) bool {
	if s.catalogo == nil || s.role == models.AgentRole("trader") {
		return false
	}
	if produjo || huboMargen {
		s.ad.ticksSinProducir = 0
		return false
	}
	// Un proceso en marcha significa que el nicho sí funciona; solo está
	// ocupado. Ídem si aún no hemos comprado nada: el bot está arrancando.
	if len(ctx.State.RunningProcesses()) > 0 {
		s.ad.ticksSinProducir = 0
		return false
	}
	s.ad.ticksSinProducir++
	if s.ad.ticksSinProducir < pivoteTicksSinProducir {
		return false
	}
	s.ad.ticksSinProducir = 0

	candidato, ok := s.elegirOficioAlternativo(ctx)
	if !ok {
		return false
	}
	anterior := s.oficio.Key
	s.oficio = candidato
	if candidato.MaxNivel > 0 {
		s.maxDesiredLevel = candidato.MaxNivel
	}
	if candidato.Freno == frenoAlmacen {
		s.p.liqCap = 1e9
	}
	s.resolverOficio(ctx)
	s.ad.stockPrevio = -1
	// log a nivel Warn a propósito: un pivote es un cambio de identidad
	// económica del bot y se quiere ver en el log del enjambre.
	ctx.Logger.Warn("pivote de oficio: el nicho no daba margen",
		"de", anterior, "a", candidato.Key, "recetas", len(s.recetas))
	return true
}

// elegirOficioAlternativo busca un oficio del mismo rol cuyo tipo de instalación
// ya esté comprado, ponderado por su peso en la flota.
func (s *ProducerStrategy) elegirOficioAlternativo(ctx *strategy.Context) (Oficio, bool) {
	var candidatos []Oficio
	var pesos []int
	total := 0
	for _, of := range s.catalogo.Oficios {
		if of.Key == s.oficio.Key || of.Rol != s.role || of.SinDemanda || of.Peso <= 0 {
			continue
		}
		tieneInstalacion := false
		for _, t := range of.Tipos {
			if inst, owned := ctx.State.Installation(t); owned && inst.Level > 0 {
				tieneInstalacion = true
				break
			}
		}
		if !tieneInstalacion {
			continue
		}
		candidatos = append(candidatos, of)
		pesos = append(pesos, of.Peso)
		total += of.Peso
	}
	if total == 0 {
		return Oficio{}, false
	}
	corte := s.rnd.IntN(total)
	for i, of := range candidatos {
		corte -= pesos[i]
		if corte < 0 {
			return of, true
		}
	}
	return candidatos[len(candidatos)-1], true
}
