package main

import (
	"fmt"
	"sort"
	"time"
)

// Composición de la flota (ADR-027).
//
// bots-v1 repartía las estrategias round-robin: `strats[(i-1)%6]`, un sexto de
// la flota para cada una. Con 10.000 bots eso son 1.667 bots para las 2 recetas
// del agua y 1.667 para las 113 industriales — un factor 57 de desequilibrio, y
// justo al revés de donde está la complejidad del catálogo.
//
// Aquí el reparto es en dos pasadas:
//
//  1. COBERTURA: `cobertura_minima` bots a cada oficio, cueste lo que cueste.
//     Un eslabón sin ningún productor real no es "un mercado fino": es una
//     receta que nadie ejecuta nunca, y todo lo que cuelga de ella se para
//     para siempre. Con reparto puramente proporcional, los oficios de peso
//     bajo salen a cero.
//  2. PESO: el resto se reparte proporcional al `peso` declarado, que refleja
//     cuántas recetas dependen de los outputs del oficio (el acero lo consumen
//     34 recetas; el asfalto, ninguna).
//
// El reparto es determinista dado (catálogo, escala): dos corridas con los
// mismos parámetros producen la misma flota, que es lo que hace comparables dos
// experimentos.

// Plaza es un puesto de la flota: el oficio que ocupa y su índice global.
type Plaza struct {
	Oficio Oficio
	// Indice global dentro de la flota (no dentro del oficio): es lo que se
	// mezcla con el runner-id para derivar el username, así que debe ser
	// estable entre corridas.
	Indice int
}

// ComponerFlota reparte `escala` plazas entre los oficios del catálogo.
//
// Devuelve las plazas en orden de oficio (no barajadas): quien quiera arrancar
// escalonado usa `RetardoDeArranque`, que ordena por capa del grafo.
func ComponerFlota(cat *CatalogoOficios, escala int) ([]Plaza, error) {
	if escala <= 0 {
		return nil, fmt.Errorf("escala debe ser > 0, es %d", escala)
	}
	n := len(cat.Oficios)
	cobertura := cat.Flota.CoberturaMinima
	if cobertura < 1 {
		cobertura = 1
	}
	if escala < n*cobertura {
		// No hay bots ni para una pasada de cobertura. Antes que dejar oficios
		// a cero en silencio, se reduce la cobertura y se avisa: con una flota
		// pequeña el usuario tiene que saber que la cadena va incompleta.
		cobertura = escala / n
		if cobertura < 1 {
			return nil, fmt.Errorf(
				"escala %d insuficiente: hay %d oficios y cada uno necesita al menos 1 bot",
				escala, n)
		}
	}

	cupo := make([]int, n)
	restantes := escala
	for i := range cat.Oficios {
		cupo[i] = cobertura
		restantes -= cobertura
	}

	// Segunda pasada: reparto proporcional al peso. Los oficios con peso 0
	// (`sin_demanda`) se quedan solo con la cobertura mínima.
	pesoTotal := 0
	for _, of := range cat.Oficios {
		if of.Peso > 0 {
			pesoTotal += of.Peso
		}
	}
	if pesoTotal > 0 && restantes > 0 {
		// Reparto exacto: floor por peso y el residuo a los mayores restos, para
		// que la suma cuadre con `escala` sin sesgar siempre al mismo oficio.
		type resto struct {
			idx int
			r   float64
		}
		restos := make([]resto, 0, n)
		asignado := 0
		for i, of := range cat.Oficios {
			if of.Peso <= 0 {
				continue
			}
			exacto := float64(restantes) * float64(of.Peso) / float64(pesoTotal)
			entero := int(exacto)
			cupo[i] += entero
			asignado += entero
			restos = append(restos, resto{idx: i, r: exacto - float64(entero)})
		}
		sort.SliceStable(restos, func(a, b int) bool { return restos[a].r > restos[b].r })
		for i := 0; asignado < restantes && i < len(restos); i++ {
			cupo[restos[i].idx]++
			asignado++
		}
	}

	plazas := make([]Plaza, 0, escala)
	idx := 0
	for i, of := range cat.Oficios {
		for j := 0; j < cupo[i]; j++ {
			plazas = append(plazas, Plaza{Oficio: of, Indice: idx})
			idx++
		}
	}
	return plazas, nil
}

// Shard recorta la flota a la parte que le toca a este runner.
//
// bots-v1 no tiene esto: cada instancia genera la flota ENTERA con otro
// namespace de usernames, así que dos runners no reparten el trabajo sino que
// duplican la economía. Con `--shard i/N` cada runner se queda con las plazas
// cuyo índice ≡ i (mod N): la unión de los N shards es exactamente la flota, sin
// huecos ni solapes, y cada oficio queda repartido entre todos los runners.
func Shard(plazas []Plaza, indice, total int) ([]Plaza, error) {
	if total <= 1 {
		return plazas, nil
	}
	if indice < 0 || indice >= total {
		return nil, fmt.Errorf("shard %d fuera de rango para %d shards", indice, total)
	}
	out := make([]Plaza, 0, len(plazas)/total+1)
	for _, p := range plazas {
		if p.Indice%total == indice {
			out = append(out, p)
		}
	}
	return out, nil
}

// RetardoDeArranque: cuánto espera una plaza antes de conectarse.
//
// bots-v1 usa jitter uniforme en [0, S]: el orden de entrada es aleatorio, así
// que la industria pesada suele arrancar antes que los pozos de agua, se
// encuentra el libro vacío y se queda con bids vivos en mercados que nadie
// surte. Aquí el retardo es `capa × segundos_por_capa` más un jitter DENTRO de
// la capa (para no meter 300 registros en el mismo segundo): el agua entra
// primero, luego las extractivas, la energía, la industria ligera y al final la
// pesada — el mismo orden en que la cadena puede empezar a producir de verdad
// desde inventario cero (ADR-022).
func RetardoDeArranque(cfg FlotaConfig, capa int, jitterIntraCapa time.Duration) time.Duration {
	base := time.Duration(capa*cfg.SegundosPorCapa) * time.Second
	return base + jitterIntraCapa
}

// ResumenFlota: una línea por oficio, para poder ver de un vistazo qué flota se
// va a lanzar sin tener que contar 10.000 logs de arranque.
func ResumenFlota(plazas []Plaza) string {
	cuenta := make(map[string]int)
	orden := make([]string, 0, 64)
	capaDe := make(map[string]int)
	sinDemanda := make(map[string]bool)
	for _, p := range plazas {
		if _, ya := cuenta[p.Oficio.Key]; !ya {
			orden = append(orden, p.Oficio.Key)
			capaDe[p.Oficio.Key] = p.Oficio.Capa
			sinDemanda[p.Oficio.Key] = p.Oficio.SinDemanda
		}
		cuenta[p.Oficio.Key]++
	}
	sort.SliceStable(orden, func(a, b int) bool {
		if capaDe[orden[a]] != capaDe[orden[b]] {
			return capaDe[orden[a]] < capaDe[orden[b]]
		}
		return cuenta[orden[a]] > cuenta[orden[b]]
	})
	out := fmt.Sprintf("Flota: %d bots en %d oficios\n", len(plazas), len(orden))
	for _, k := range orden {
		nota := ""
		if sinDemanda[k] {
			nota = "  (sin demanda en el catálogo: solo cobertura)"
		}
		out += fmt.Sprintf("  capa %d  %-24s %5d%s\n", capaDe[k], k, cuenta[k], nota)
	}
	return out
}
