package main

import (
	"testing"
	"time"
)

func catalogoDePrueba() *CatalogoOficios {
	return &CatalogoOficios{
		Version: 1,
		Flota:   FlotaConfig{CoberturaMinima: 3, SegundosPorCapa: 90},
		Oficios: []Oficio{
			{Key: "aguador", Rol: "transformer", Capa: 0, Peso: 90},
			{Key: "siderurgico", Rol: "transformer", Capa: 2, Peso: 50},
			{Key: "muerto", Rol: "transformer", Capa: 2, Peso: 0, SinDemanda: true},
		},
	}
}

func cuentaPorOficio(plazas []Plaza) map[string]int {
	out := make(map[string]int)
	for _, p := range plazas {
		out[p.Oficio.Key]++
	}
	return out
}

func TestComponerFlotaRespetaEscalaYCobertura(t *testing.T) {
	cat := catalogoDePrueba()
	plazas, err := ComponerFlota(cat, 1000)
	if err != nil {
		t.Fatalf("ComponerFlota: %v", err)
	}
	if len(plazas) != 1000 {
		t.Fatalf("se pidieron 1000 plazas y salieron %d", len(plazas))
	}
	cuenta := cuentaPorOficio(plazas)
	for _, of := range cat.Oficios {
		if cuenta[of.Key] < cat.Flota.CoberturaMinima {
			t.Errorf("oficio %q con %d bots, por debajo de la cobertura mínima %d",
				of.Key, cuenta[of.Key], cat.Flota.CoberturaMinima)
		}
	}
	// Un oficio de peso 0 se queda EXACTAMENTE en la cobertura: es la garantía
	// de que un nicho sin demanda no se lleve bots del resto.
	if cuenta["muerto"] != cat.Flota.CoberturaMinima {
		t.Errorf("oficio sin demanda con %d bots, se esperaba solo la cobertura (%d)",
			cuenta["muerto"], cat.Flota.CoberturaMinima)
	}
	// Y el reparto sigue el peso: 90 contra 50.
	if cuenta["aguador"] <= cuenta["siderurgico"] {
		t.Errorf("el reparto no respeta el peso: aguador=%d siderurgico=%d",
			cuenta["aguador"], cuenta["siderurgico"])
	}
}

// El caso que bots-v1 nunca planteó: una flota pequeña. Antes que dejar oficios
// a cero en silencio (un eslabón sin productor para la corrida entera), la
// cobertura se reduce hasta donde alcance.
func TestComponerFlotaConEscalaPequena(t *testing.T) {
	cat := catalogoDePrueba()
	plazas, err := ComponerFlota(cat, 4)
	if err != nil {
		t.Fatalf("ComponerFlota: %v", err)
	}
	if len(plazas) != 4 {
		t.Fatalf("se pidieron 4 plazas y salieron %d", len(plazas))
	}
	cuenta := cuentaPorOficio(plazas)
	for _, of := range cat.Oficios {
		if cuenta[of.Key] < 1 {
			t.Errorf("oficio %q sin ningún bot: la cadena quedaría rota", of.Key)
		}
	}
	if _, err := ComponerFlota(cat, 2); err == nil {
		t.Error("con menos bots que oficios se esperaba error, no una flota incompleta en silencio")
	}
}

func TestComponerFlotaEsDeterminista(t *testing.T) {
	cat := catalogoDePrueba()
	a, err := ComponerFlota(cat, 500)
	if err != nil {
		t.Fatal(err)
	}
	b, err := ComponerFlota(cat, 500)
	if err != nil {
		t.Fatal(err)
	}
	for i := range a {
		if a[i].Oficio.Key != b[i].Oficio.Key || a[i].Indice != b[i].Indice {
			t.Fatalf("plaza %d difiere entre dos composiciones: %v vs %v", i, a[i], b[i])
		}
	}
}

// La unión de los N shards debe ser EXACTAMENTE la flota: ni huecos (un oficio
// que nadie lanza) ni solapes (dos runners con la misma cuenta, que se rotarían
// mutuamente el refresh token de un solo uso).
func TestShardParticionaLaFlota(t *testing.T) {
	cat := catalogoDePrueba()
	plazas, err := ComponerFlota(cat, 997)
	if err != nil {
		t.Fatal(err)
	}
	const total = 4
	visto := make(map[int]int)
	suma := 0
	for i := 0; i < total; i++ {
		parte, err := Shard(plazas, i, total)
		if err != nil {
			t.Fatal(err)
		}
		suma += len(parte)
		for _, p := range parte {
			visto[p.Indice]++
		}
	}
	if suma != len(plazas) {
		t.Errorf("los %d shards suman %d plazas, la flota tiene %d", total, suma, len(plazas))
	}
	for _, p := range plazas {
		if visto[p.Indice] != 1 {
			t.Errorf("la plaza %d aparece en %d shards, debería aparecer en 1", p.Indice, visto[p.Indice])
		}
	}
	if _, err := Shard(plazas, 4, 4); err == nil {
		t.Error("shard fuera de rango debería fallar")
	}
}

func TestRetardoDeArranqueOrdenaPorCapa(t *testing.T) {
	cfg := FlotaConfig{CoberturaMinima: 3, SegundosPorCapa: 90}
	agua := RetardoDeArranque(cfg, 0, 0)
	industria := RetardoDeArranque(cfg, 6, 0)
	if agua >= industria {
		t.Errorf("el agua (capa 0, %v) debe arrancar antes que la industria pesada (capa 6, %v)", agua, industria)
	}
	if industria != 9*time.Minute {
		t.Errorf("capa 6 × 90 s = 9m, salió %v", industria)
	}
	// El jitter separa a los bots DENTRO de una capa sin invadir la siguiente.
	conJitter := RetardoDeArranque(cfg, 0, 30*time.Second)
	if conJitter >= RetardoDeArranque(cfg, 1, 0) {
		t.Errorf("el jitter intra-capa (%v) no debe alcanzar a la capa siguiente", conJitter)
	}
}

func TestValidarRechazaRecetaEnDosOficios(t *testing.T) {
	cat := &CatalogoOficios{Oficios: []Oficio{
		{Key: "a", Rol: "transformer", Recetas: []string{"molienda"}},
		{Key: "b", Rol: "transformer", Recetas: []string{"molienda"}},
	}}
	if err := cat.Validar(); err == nil {
		t.Error("una receta en dos oficios debería ser un error de validación")
	}
}

func TestValidarRechazaRolNoRegistrable(t *testing.T) {
	cat := &CatalogoOficios{Oficios: []Oficio{{Key: "a", Rol: "city"}}}
	if err := cat.Validar(); err == nil {
		t.Error("el rol city no es registrable por bots-v2: debería fallar")
	}
}
