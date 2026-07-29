package main

import (
	"encoding/json"
	"os"
	"testing"
)

// El catálogo de oficios está escrito A MANO, así que lo que impide que se
// quede atrás cuando alguien toca `infra/seed-config.json` es este test: las
// 152 recetas tienen que tener oficio, exactamente uno, y del tipo correcto.
//
// Es el mismo papel que `catalog-artifacts.test.ts` hace en el backend con los
// precios base de los bots.

type seedConfig struct {
	Recipes []struct {
		Key             string `json:"key"`
		Output          string `json:"output"`
		InstallationTyp string `json:"installation_type"`
		Inputs          []struct {
			Product string `json:"product"`
		} `json:"inputs"`
	} `json:"recipes"`
	Products []struct {
		Key      string `json:"key"`
		Category string `json:"category"`
	} `json:"products"`
	InstallationTypes []struct {
		Key     string   `json:"key"`
		Recipes []string `json:"recipes"`
	} `json:"installation_types"`
}

const seedConfigPath = "../infra/seed-config.json"

func cargarSeed(t *testing.T) seedConfig {
	t.Helper()
	raw, err := os.ReadFile(seedConfigPath)
	if err != nil {
		t.Fatalf("no se pudo leer %s: %v", seedConfigPath, err)
	}
	var cfg seedConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("seed-config ilegible: %v", err)
	}
	if len(cfg.Recipes) == 0 {
		t.Fatal("seed-config sin recetas")
	}
	return cfg
}

func cargarCatalogo(t *testing.T) *CatalogoOficios {
	t.Helper()
	cat, err := CargarOficios("oficios.yaml")
	if err != nil {
		t.Fatalf("oficios.yaml inválido: %v", err)
	}
	return cat
}

func TestOficiosCubrenTodasLasRecetas(t *testing.T) {
	seed := cargarSeed(t)
	cat := cargarCatalogo(t)

	dueno := make(map[string]string, len(seed.Recipes))
	for _, of := range cat.Oficios {
		for _, rk := range of.Recetas {
			if prev, ya := dueno[rk]; ya {
				t.Errorf("receta %q en dos oficios: %q y %q", rk, prev, of.Key)
			}
			dueno[rk] = of.Key
		}
	}

	conocidas := make(map[string]bool, len(seed.Recipes))
	for _, r := range seed.Recipes {
		conocidas[r.Key] = true
		if _, ok := dueno[r.Key]; !ok {
			t.Errorf("receta %q sin oficio: nadie la produciría en toda la corrida", r.Key)
		}
	}
	for rk, of := range dueno {
		if !conocidas[rk] {
			t.Errorf("oficio %q declara la receta %q, que no existe en el catálogo", of, rk)
		}
	}
}

func TestOficiosDeclaranElTipoDeSusRecetas(t *testing.T) {
	seed := cargarSeed(t)
	cat := cargarCatalogo(t)

	tipoDe := make(map[string]string)
	for _, it := range seed.InstallationTypes {
		for _, rk := range it.Recipes {
			tipoDe[rk] = it.Key
		}
	}

	for _, of := range cat.Oficios {
		declarados := make(map[string]bool, len(of.Tipos))
		for _, tk := range of.Tipos {
			declarados[tk] = true
		}
		for _, rk := range of.Recetas {
			// El tipo es lo que el bot COMPRA (ADR-021): si no lo declara, no
			// puede comprar la instalación y la receta es letra muerta. También
			// es lo que usa el fallback cuando el servidor no expone recipe.key.
			if tipo := tipoDe[rk]; !declarados[tipo] {
				t.Errorf("oficio %q produce %q (tipo %q) pero no declara ese tipo en `tipos`",
					of.Key, rk, tipo)
			}
		}
	}
}

// Un oficio marcado `sin_demanda` afirma algo comprobable: que NADIE DE FUERA
// compraría nunca nada de lo que produce.
//
// "De fuera" es la parte importante. Un oficio puede consumir sus propios
// productos intermedios —el papelero hace celulosa para hacer papel y papel
// para hacer cartón— y eso NO es demanda: si el último eslabón de esa cadena no
// lo compra nadie, el oficio entero solo puede quemar capital. Contar el consumo
// interno como demanda dejaba pasar exactamente ese caso.
func TestSinDemandaEsCierto(t *testing.T) {
	seed := cargarSeed(t)
	cat := cargarCatalogo(t)

	final := make(map[string]bool)
	for _, p := range seed.Products {
		if p.Category == "final_consumption" {
			final[p.Key] = true
		}
	}
	outputDe := make(map[string]string, len(seed.Recipes))
	for _, r := range seed.Recipes {
		outputDe[r.Key] = r.Output
	}

	for _, of := range cat.Oficios {
		if len(of.Recetas) == 0 {
			continue
		}
		propias := make(map[string]bool, len(of.Recetas))
		for _, rk := range of.Recetas {
			propias[rk] = true
		}
		// Lo que consumen las recetas de OTROS oficios.
		consumidoFuera := make(map[string]bool)
		for _, r := range seed.Recipes {
			if propias[r.Key] {
				continue
			}
			for _, in := range r.Inputs {
				consumidoFuera[in.Product] = true
			}
		}

		algunoConDemanda := false
		for _, rk := range of.Recetas {
			out := outputDe[rk]
			if consumidoFuera[out] || final[out] {
				algunoConDemanda = true
				break
			}
		}
		switch {
		case of.SinDemanda && algunoConDemanda:
			t.Errorf("oficio %q está marcado sin_demanda pero alguno de sus outputs sí se consume: quítale la marca y devuélvele el peso", of.Key)
		case !of.SinDemanda && !algunoConDemanda:
			t.Errorf("oficio %q no tiene ni un output con demanda en el catálogo: márcalo sin_demanda (peso 0) o el enjambre gastará bots en quebrar", of.Key)
		}
	}
}

// El creador de mercado es el único oficio que NO produce: no tiene recetas ni
// tipos, y el runner tiene que despacharlo a TraderStrategy y registrarlo con el
// rol `trader`. Es el punto donde el cableado nuevo de v2 (oficio → estrategia)
// podría dejar sin liquidez al mercado entero sin que nada más falle: un trader
// registrado como `transformer` arrancaría, cotizaría y el servidor le
// rechazaría... nada, simplemente sería un productor sin instalaciones.
func TestElCreadorDeMercadoSeRegistraComoTrader(t *testing.T) {
	cat := cargarCatalogo(t)
	of, ok := cat.Por("creador_mercado")
	if !ok {
		t.Fatal("falta el oficio creador_mercado: el mercado se quedaría sin market makers")
	}
	if of.Rol != "trader" {
		t.Errorf("creador_mercado tiene rol %q, se esperaba trader", of.Rol)
	}
	if len(of.Recetas) != 0 || len(of.Tipos) != 0 {
		t.Errorf("el trader no produce: recetas=%v tipos=%v", of.Recetas, of.Tipos)
	}
	if of.Peso <= 0 {
		t.Error("el creador de mercado con peso 0 dejaría el libro sin las dos puntas")
	}

	// Y el reparto de la flota tiene que propagar ese rol al registro.
	bots, err := construirFlota(GlobalConfig{Scale: 1000}, cat, 0, "", "test-runner", true)
	if err != nil {
		t.Fatalf("construirFlota: %v", err)
	}
	traders := 0
	for _, b := range bots {
		if b.Oficio != "creador_mercado" {
			continue
		}
		traders++
		if b.Role != "trader" {
			t.Fatalf("bot %s del oficio creador_mercado se registraría como %q", b.Username, b.Role)
		}
	}
	if traders == 0 {
		t.Error("la flota de 1000 bots no incluye ningún creador de mercado")
	}
}

func TestOficiosSinDemandaNoLlevanPeso(t *testing.T) {
	cat := cargarCatalogo(t)
	for _, of := range cat.Oficios {
		if of.SinDemanda && of.Peso > 0 {
			t.Errorf("oficio %q es sin_demanda pero tiene peso %d: solo debe recibir cobertura mínima", of.Key, of.Peso)
		}
	}
}
