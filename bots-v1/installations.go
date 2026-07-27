package main

import (
	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// installationForRecipe resuelve la instalación del agente que habilita una
// receta (economía de instalaciones, ADR-021): recipe.InstallationTypeID →
// tipo del catálogo → instalación comprada (por key del tipo).
//
// Devuelve (instalación, tipo, owned, typeKnown). `owned` es true si el agente
// ya compró el tipo; `typeKnown` es false si el catálogo de tipos aún no cargó.
func installationForRecipe(
	ctx *strategy.Context,
	recipe models.Recipe,
) (models.InstallationStatus, models.InstallationType, bool, bool) {
	t, ok := ctx.State.InstallationTypeByID(recipe.InstallationTypeID)
	if !ok {
		return models.InstallationStatus{}, models.InstallationType{}, false, false
	}
	inst, owned := ctx.State.Installation(t.Key)
	return inst, t, owned, true
}

// installationBuyAction decide si comprar (nivel 0→1) o mejorar (+1) la
// instalación de `recipe` cuando la producción está bloqueada por falta de
// huecos, y hay capital de sobra. Devuelve la acción, el precio que costará
// (para descontarlo del capital comprometido en el tick) y true si procede.
//
// Reglas conservadoras (evitan descapitalizar al bot):
//   - Solo compra/mejora si el capital disponible cubre el precio con un colchón
//     (`capitalReserveFactor`×) Y si al pagarlo queda `workingCapital`, el
//     dinero que hace falta para insumos y salarios del nivel resultante. El
//     colchón relativo solo no basta: el precio crece ×1,7 por nivel mientras
//     el capital de trabajo crece linealmente, así que a partir del nivel 2 un
//     bot puede pasar el múltiplo y quedarse sin con qué alimentar la línea que
//     acaba de comprar (capex sin opex: instalación grande, producción cero).
//   - No mejora más allá de `maxDesiredLevel` (aunque el tipo permita más).
//   - Compra inicial (no owned) usa base_price; mejora usa next_upgrade_price.
func installationBuyAction(
	inst models.InstallationStatus,
	typ models.InstallationType,
	owned bool,
	capitalAvail int64,
	workingCapital int64,
	maxDesiredLevel int,
	capitalReserveFactor int64,
) (actions.AcquireInstallation, int64, bool) {
	if !owned {
		price := typ.BasePriceCents
		if !capitalAlcanza(capitalAvail, price, workingCapital, capitalReserveFactor) {
			return actions.AcquireInstallation{}, 0, false
		}
		return actions.AcquireInstallation{
			InstallationType:     typ.Key,
			ExpectedCurrentLevel: 0,
		}, price, true
	}
	// Owned: solo mejorar si está saturada (sin huecos) y no llegó al tope.
	if inst.AvailableSlots > 0 || inst.Level >= maxDesiredLevel {
		return actions.AcquireInstallation{}, 0, false
	}
	if inst.NextUpgradePriceCents == nil {
		return actions.AcquireInstallation{}, 0, false // nivel máximo del catálogo.
	}
	price := *inst.NextUpgradePriceCents
	if !capitalAlcanza(capitalAvail, price, workingCapital, capitalReserveFactor) {
		return actions.AcquireInstallation{}, 0, false
	}
	return actions.AcquireInstallation{
		InstallationType:     typ.Key,
		ExpectedCurrentLevel: inst.Level,
	}, price, true
}

// capitalAlcanza: el capex pasa el colchón relativo y además deja intacto el
// capital de trabajo. Las dos condiciones a la vez, nunca una sola.
func capitalAlcanza(capitalAvail, price, workingCapital, capitalReserveFactor int64) bool {
	if price <= 0 {
		return false
	}
	return capitalAvail >= price*capitalReserveFactor &&
		capitalAvail-price >= workingCapital
}

// insumosCubrenNivelExtra: ¿hay insumos —inventario más bids vivos— para
// alimentar el nivel que abriría la mejora, contando que los niveles actuales
// también tendrán que recargar al terminar?
//
// Ampliar una instalación cuyo insumo no se tiene compra huecos vacíos: el
// capital se va en capex, después no queda para el insumo y la línea nueva nace
// parada mientras la vieja se queda sin reponer. El energético es el caso
// evidente (ADR-024): primero el agua, después la turbina. La compra INICIAL no
// pasa por aquí — sin instalación no hay nada que alimentar y el bot nunca
// arrancaría.
func insumosCubrenNivelExtra(
	ctx *strategy.Context,
	recipe models.Recipe,
	inst models.InstallationStatus,
	activeBuyQty map[string]int64,
) bool {
	for _, input := range recipe.Inputs {
		inv := ctx.State.InventoryForProduct(input.ProductID)
		necesario := input.QtyRequiredCent * int64(inst.Level+1)
		if inv.QtyAvailableCent+activeBuyQty[input.ProductID] < necesario {
			return false
		}
	}
	return true
}
