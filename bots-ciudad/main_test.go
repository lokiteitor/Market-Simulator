package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/lokiteitor/market-simulator/sdk/models"
)

// loadCities lee la MISMA fuente que el seed del backend (infra/cities.json), así
// que un cambio de formato ahí rompe el arranque de las 50 ciudades. Desde
// ADR-029 el fichero es solo la lista de cuentas: la población ya no se declara.
func TestLoadCities_LeeElFicheroRealSinPoblacion(t *testing.T) {
	cities, err := loadCities(filepath.Join("..", "infra", "cities.json"))
	if err != nil {
		t.Fatalf("loadCities: %v", err)
	}
	if len(cities) < 50 {
		t.Fatalf("se esperaban ~50 capitales, hay %d", len(cities))
	}
	vistos := make(map[string]bool, len(cities))
	for _, c := range cities {
		if c.Username == "" {
			t.Fatalf("ciudad sin username: %+v", c)
		}
		if vistos[c.Username] {
			// Dos cuentas iguales se rotarían el refresh token de un solo uso.
			t.Fatalf("username duplicado en cities.json: %q", c.Username)
		}
		vistos[c.Username] = true
	}
}

// Un cities.json antiguo (con population_weight) sigue cargando: el campo ya no
// existe en la struct y json lo ignora, así que actualizar el binario no exige
// tocar el fichero.
func TestLoadCities_ToleraElFormatoAntiguo(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cities.json")
	body := `{"cities":[{"username":"lima","display":"Lima","population_weight":11000}]}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	cities, err := loadCities(path)
	if err != nil {
		t.Fatalf("loadCities: %v", err)
	}
	if len(cities) != 1 || cities[0].Username != "lima" {
		t.Fatalf("cities = %+v", cities)
	}
}

func TestLoadCities_FicheroInexistente(t *testing.T) {
	if _, err := loadCities(filepath.Join(t.TempDir(), "no-existe.json")); err == nil {
		t.Fatal("se esperaba error al leer un fichero inexistente")
	}
}

// buildCityConfig es el punto donde la config global se convierte en la sesión
// de UNA ciudad: login-only (la cuenta ya está sembrada) y con la config de la
// demanda urbana enchufada a la estrategia.
func TestBuildCityConfig_LoginOnlyYConfigDeDemandaUrbana(t *testing.T) {
	cfg := &GlobalConfig{
		SimTimeFactor:       5,
		CityPassword:        "secreta",
		TickIntervalSeconds: 5,
		NeedsRefreshSeconds: 30,
		HousingShare:        0.25,
		Prices:              map[string]interface{}{"pan": 190},
		Market:              map[string]interface{}{"ema_alpha": 0.25},
	}

	got := buildCityConfig(City{Username: "tokyo", Display: "Tokyo"}, cfg)
	if got.Bot.AutoRegister {
		// Las ciudades NO son registrables: el seed las crea con credenciales.
		t.Fatal("una ciudad no debe auto-registrarse")
	}
	if got.Bot.Role != models.RoleCity {
		t.Fatalf("rol = %q, se esperaba city", got.Bot.Role)
	}
	if got.Bot.Username != "tokyo" || got.Bot.Password != "secreta" {
		t.Fatalf("credenciales = %q/%q", got.Bot.Username, got.Bot.Password)
	}
	for _, clave := range []string{"prices", "market", "sim_time_factor", "needs_refresh_seconds", "housing_share"} {
		if _, ok := got.Strategy[clave]; !ok {
			t.Fatalf("falta %q en la config de estrategia: %v", clave, got.Strategy)
		}
	}
}
