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
// huecos, y hay capital de sobra. Devuelve la acción y true si procede.
//
// Reglas conservadoras (evitan descapitalizar al bot):
//   - Solo compra/mejora si el capital disponible cubre el precio con un colchón
//     (`capitalReserveFactor`×) para no dejarse sin fondos para salarios/insumos.
//   - No mejora más allá de `maxDesiredLevel` (aunque el tipo permita más).
//   - Compra inicial (no owned) usa base_price; mejora usa next_upgrade_price.
func installationBuyAction(
	inst models.InstallationStatus,
	typ models.InstallationType,
	owned bool,
	capitalAvail int64,
	maxDesiredLevel int,
	capitalReserveFactor int64,
) (actions.AcquireInstallation, bool) {
	if !owned {
		price := typ.BasePriceCents
		if price <= 0 || capitalAvail < price*capitalReserveFactor {
			return actions.AcquireInstallation{}, false
		}
		return actions.AcquireInstallation{
			InstallationType:     typ.Key,
			ExpectedCurrentLevel: 0,
		}, true
	}
	// Owned: solo mejorar si está saturada (sin huecos) y no llegó al tope.
	if inst.AvailableSlots > 0 || inst.Level >= maxDesiredLevel {
		return actions.AcquireInstallation{}, false
	}
	if inst.NextUpgradePriceCents == nil {
		return actions.AcquireInstallation{}, false // nivel máximo del catálogo.
	}
	price := *inst.NextUpgradePriceCents
	if price <= 0 || capitalAvail < price*capitalReserveFactor {
		return actions.AcquireInstallation{}, false
	}
	return actions.AcquireInstallation{
		InstallationType:     typ.Key,
		ExpectedCurrentLevel: inst.Level,
	}, true
}
