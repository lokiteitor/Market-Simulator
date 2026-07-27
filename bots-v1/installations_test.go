package main

import (
	"testing"

	"github.com/lokiteitor/market-simulator/sdk/models"
)

// El caso que motiva el capital de trabajo (ADR-021 + ADR-024): `generacion`
// cuesta 50.000 ¢ y sube ×1,7 por nivel, mientras alimentar una línea de
// `generacion_hidro` cuesta 13.200 ¢ por ejecución (600 u de agua a 10 ¢ más
// 7.200 ¢ de salario). Con solo el colchón relativo, un energético con capital
// justo pasaba el ×3, se quedaba sin efectivo para el agua y la turbina nueva
// nacía parada.
const (
	generacionBasePrice = int64(50_000)
	hidroExecCost       = int64(13_200)
	reserva             = int64(3)
)

func tipoGeneracion() models.InstallationType {
	return models.InstallationType{
		Key:            "generacion",
		Role:           "transformer",
		BasePriceCents: generacionBasePrice,
		GrowthBps:      17000,
		MaxLevel:       10,
	}
}

func TestInstallationBuyAction_CompraInicialExigeCapitalDeTrabajo(t *testing.T) {
	typ := tipoGeneracion()
	trabajo := hidroExecCost * 1 * 5 // nivel resultante 1, buffer de 5 ejecuciones

	// 160.000 pasa el colchón (50.000×3 = 150.000) y al pagar deja 110.000,
	// de sobra para los 66.000 de trabajo: compra.
	if _, price, ok := installationBuyAction(models.InstallationStatus{}, typ, false, 160_000, trabajo, 4, reserva); !ok {
		t.Fatalf("con 160.000 ¢ debería comprar (precio %d, trabajo %d)", price, trabajo)
	}

	// El caso que el colchón relativo no veía: pasa el ×3 pero el remanente no
	// cubre el capital de trabajo.
	trabajoAlto := int64(120_000)
	if _, _, ok := installationBuyAction(models.InstallationStatus{}, typ, false, 150_000, trabajoAlto, 4, reserva); ok {
		t.Fatal("no debería comprar: al pagar quedan 100.000 ¢ y el trabajo exige 120.000 ¢")
	}
}

func TestInstallationBuyAction_MejoraNoDescapitaliza(t *testing.T) {
	typ := tipoGeneracion()
	upgrade := int64(85_000) // nivel 1→2
	inst := models.InstallationStatus{
		InstallationType:      "generacion",
		Level:                 1,
		Running:               1,
		AvailableSlots:        0,
		NextUpgradePriceCents: &upgrade,
	}
	trabajo := hidroExecCost * 2 * 5 // el nivel 2 hay que alimentarlo entero: 132.000

	// 255.000 pasa el colchón ×3 y deja 170.000 > 132.000: mejora.
	buy, price, ok := installationBuyAction(inst, typ, true, 255_000, trabajo, 4, reserva)
	if !ok {
		t.Fatal("con 255.000 ¢ debería mejorar")
	}
	if price != upgrade {
		t.Fatalf("precio devuelto %d, esperado %d", price, upgrade)
	}
	if buy.ExpectedCurrentLevel != 1 {
		t.Fatalf("expected_current_level %d, esperado 1", buy.ExpectedCurrentLevel)
	}

	// Mismo capital, receta con insumos caros: el remanente ya no cubre el
	// capital de trabajo y la mejora se descarta aunque el ×3 lo permita.
	if _, _, ok := installationBuyAction(inst, typ, true, 255_000, 200_000, 4, reserva); ok {
		t.Fatal("no debería mejorar: al pagar quedan 170.000 ¢ y el trabajo exige 200.000 ¢")
	}
}

func TestInstallationBuyAction_NoMejoraConHuecosLibresNiEnElTope(t *testing.T) {
	typ := tipoGeneracion()
	upgrade := int64(85_000)
	capital := int64(10_000_000)

	conHueco := models.InstallationStatus{Level: 1, AvailableSlots: 1, NextUpgradePriceCents: &upgrade}
	if _, _, ok := installationBuyAction(conHueco, typ, true, capital, 0, 4, reserva); ok {
		t.Fatal("no debería mejorar una instalación con huecos libres")
	}

	enTope := models.InstallationStatus{Level: 4, AvailableSlots: 0, NextUpgradePriceCents: &upgrade}
	if _, _, ok := installationBuyAction(enTope, typ, true, capital, 0, 4, reserva); ok {
		t.Fatal("no debería mejorar por encima de maxDesiredLevel")
	}

	sinPrecio := models.InstallationStatus{Level: 2, AvailableSlots: 0}
	if _, _, ok := installationBuyAction(sinPrecio, typ, true, capital, 0, 4, reserva); ok {
		t.Fatal("no debería mejorar sin next_upgrade_price (nivel máximo del catálogo)")
	}
}
