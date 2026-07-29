package main

import (
	"fmt"
	"os"

	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
	"gopkg.in/yaml.v3"
)

// Oficio: la unidad de especialización de bots-v2 (ADR-027).
//
// En bots-v1 lo que repartía el catálogo entre bots era el TIPO de instalación
// (`specialties.go`), y eso tenía dos problemas que ningún ajuste de parámetros
// arregla:
//
//  1. El reparto no se parece al catálogo. El round-robin de v1 daba 1/6 de la
//     flota a las 2 recetas del agua y otro 1/6 a las 113 industriales.
//  2. Dentro de un tipo, el nivel de la instalación es un presupuesto de
//     concurrencia COMPARTIDO (ADR-021), así que un bot con nivel 3 en
//     `componentes` no cubre sus 20 recetas: cubre 3, y cuáles es cosa del
//     `rnd.Perm` de cada tick. Los eslabones que se quedan sin productor real
//     paran todo lo que cuelga de ellos.
//
// El oficio nombra RECETAS concretas. `bots-hidro` era exactamente esto —una
// especialización dentro de `generacion`— resuelto duplicando un binario;
// aquí es un oficio con tres campos.
type Oficio struct {
	Key      string           `yaml:"key"`
	Nombre   string           `yaml:"nombre"`
	Rol      models.AgentRole `yaml:"rol"`
	Tipos    []string         `yaml:"tipos"`
	Recetas  []string         `yaml:"recetas"`
	Capa     int              `yaml:"capa"`
	Peso     int              `yaml:"peso"`
	MaxNivel int              `yaml:"max_nivel"`

	// Lista blanca de insumos: descarta las recetas del oficio que consuman
	// cualquier otra cosa. La usa el hidroeléctrico y MANDA sobre
	// ExigirSinYacimiento, porque `GET /catalog/deposits` puede fallar al
	// arrancar y el engine sigue asumiendo recursos infinitos: con solo el
	// criterio del yacimiento, un fallo de red convierte a la hidro en una
	// térmica que quema carbón.
	InsumosPermitidos []string `yaml:"insumos_permitidos"`
	// Descarta recetas con algún insumo de yacimiento finito (ADR-023).
	ExigirSinYacimiento bool `yaml:"exigir_sin_yacimiento"`
	// apagadoCosteMargen (default) | apagadoCosteVariable.
	Apagado string `yaml:"apagado"`
	// frenoPrecio (default) | frenoAlmacen.
	Freno              string `yaml:"freno"`
	InventarioMaxExecs int    `yaml:"inventario_max_execs"`
	// Documenta que NINGÚN output del oficio se consume en el catálogo. Van con
	// peso 0: su único destino garantizado es la quiebra.
	SinDemanda bool `yaml:"sin_demanda"`
}

const (
	apagadoCosteMargen   = "coste_margen"
	apagadoCosteVariable = "coste_variable"
	frenoPrecio          = "precio"
	frenoAlmacen         = "almacen"
)

// FlotaConfig: parámetros de composición de la flota.
type FlotaConfig struct {
	// Bots asignados a CADA oficio antes de repartir por peso. Es lo que impide
	// que un eslabón nazca huérfano.
	CoberturaMinima int `yaml:"cobertura_minima"`
	// Separación real entre capas al arrancar (jitter ordenado por profundidad
	// del grafo en vez de uniforme).
	SegundosPorCapa int `yaml:"segundos_por_capa"`
}

type CatalogoOficios struct {
	Version int         `yaml:"version"`
	Flota   FlotaConfig `yaml:"flota"`
	Oficios []Oficio    `yaml:"oficios"`
}

// CargarOficios lee y valida el catálogo de oficios.
func CargarOficios(path string) (*CatalogoOficios, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("leyendo %s: %w", path, err)
	}
	var cat CatalogoOficios
	if err := yaml.Unmarshal(data, &cat); err != nil {
		return nil, fmt.Errorf("parseando %s: %w", path, err)
	}
	if err := cat.Validar(); err != nil {
		return nil, err
	}
	return &cat, nil
}

// Validar comprueba lo que se puede comprobar sin catálogo del servidor: keys
// únicas, recetas no repetidas entre oficios y coherencia de los enums.
//
// La cobertura de las 138 recetas NO se valida aquí (el binario no lee
// seed-config.json): la vigila `oficios_test.go`, que sí lo hace.
func (c *CatalogoOficios) Validar() error {
	if len(c.Oficios) == 0 {
		return fmt.Errorf("el catálogo de oficios está vacío")
	}
	keys := make(map[string]bool, len(c.Oficios))
	duenoDeReceta := make(map[string]string)
	for _, of := range c.Oficios {
		if of.Key == "" {
			return fmt.Errorf("oficio sin key")
		}
		if keys[of.Key] {
			return fmt.Errorf("oficio duplicado: %q", of.Key)
		}
		keys[of.Key] = true
		if of.Rol != models.AgentRole("transformer") && of.Rol != models.AgentRole("trader") {
			return fmt.Errorf("oficio %q: rol no registrable %q", of.Key, of.Rol)
		}
		switch of.Apagado {
		case "", apagadoCosteMargen, apagadoCosteVariable:
		default:
			return fmt.Errorf("oficio %q: apagado desconocido %q", of.Key, of.Apagado)
		}
		switch of.Freno {
		case "", frenoPrecio, frenoAlmacen:
		default:
			return fmt.Errorf("oficio %q: freno desconocido %q", of.Key, of.Freno)
		}
		for _, rk := range of.Recetas {
			if prev, ya := duenoDeReceta[rk]; ya {
				// Dos oficios con la misma receta no es un error de sintaxis
				// pero sí de diseño: la cobertura mínima dejaría de repartirse
				// como uno cree y el peso de esa receta se contaría dos veces.
				return fmt.Errorf("receta %q asignada a dos oficios (%q y %q)", rk, prev, of.Key)
			}
			duenoDeReceta[rk] = of.Key
		}
	}
	return nil
}

// Por keys de oficio.
func (c *CatalogoOficios) Por(key string) (Oficio, bool) {
	for _, of := range c.Oficios {
		if of.Key == key {
			return of, true
		}
	}
	return Oficio{}, false
}

// -----------------------------------------------------------------------------
// Resolución contra el catálogo del servidor
// -----------------------------------------------------------------------------

// ResolverRecetas traduce las claves del oficio a las recetas del catálogo que
// el bot debe producir.
//
// Vía principal: `recipe.key`, la clave estable del catálogo. Fallback: si el
// servidor no la expone (es anterior a la columna, ver
// `backend/src/scripts/backfill-recipe-keys.ts`), NO hay forma de nombrar una
// receta concreta desde el cliente y el oficio degrada a "todas las recetas de
// mis tipos" — que es exactamente el comportamiento de bots-v1. Se avisa,
// porque en ese modo la especialización fina no existe.
func ResolverRecetas(ctx *strategy.Context, of Oficio) ([]models.Recipe, bool) {
	quiere := make(map[string]bool, len(of.Recetas))
	for _, rk := range of.Recetas {
		quiere[rk] = true
	}
	tipos := make(map[string]bool, len(of.Tipos))
	for _, t := range of.Tipos {
		tipos[t] = true
	}

	todas := ctx.State.CatalogRecipes()
	conKey := 0
	for _, r := range todas {
		if r.Key != "" {
			conKey++
		}
	}
	degradado := conKey == 0

	out := make([]models.Recipe, 0, len(of.Recetas))
	for _, r := range todas {
		typ, ok := ctx.State.InstallationTypeByID(r.InstallationTypeID)
		if !ok || !tipos[typ.Key] {
			continue
		}
		if !degradado && !quiere[r.Key] {
			continue
		}
		if !recetaAdmitida(ctx, of, r) {
			continue
		}
		out = append(out, r)
	}
	return out, degradado
}

// recetaAdmitida aplica los filtros de insumos del oficio: la lista blanca y la
// exigencia de no depender de un yacimiento finito.
func recetaAdmitida(ctx *strategy.Context, of Oficio, r models.Recipe) bool {
	if len(of.InsumosPermitidos) > 0 {
		permitido := make(map[string]bool, len(of.InsumosPermitidos))
		for _, k := range of.InsumosPermitidos {
			if p, ok := ctx.State.ProductByKey(k); ok {
				permitido[p.ProductID] = true
			}
		}
		for _, in := range r.Inputs {
			if !permitido[in.ProductID] {
				return false
			}
		}
	}
	if of.ExigirSinYacimiento {
		for _, in := range r.Inputs {
			if _, finito := ctx.State.Deposit(in.ProductID); finito {
				return false
			}
		}
	}
	return true
}
