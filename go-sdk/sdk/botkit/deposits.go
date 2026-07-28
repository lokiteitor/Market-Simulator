package botkit

import (
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

// EffectiveOutputQtyCent es lo que una ejecucion produce DE VERDAD: el output
// nominal de la receta escalado por el rendimiento de su yacimiento (ADR-023).
//
// Para los productos inagotables devuelve el output tal cual. Para los recursos
// no renovables cae con el vaciado del yacimiento, y usarlo importa: el salario
// y los insumos se pagan enteros produzca lo que produzca la mina, asi que
// valorar la receta con el output nominal cuando el yacimiento esta a la mitad
// hace creer que se gana el doble de lo que se gana. Un bot que ignore esto mina
// a perdida convencido de que le renta.
func EffectiveOutputQtyCent(ctx *strategy.Context, recipe models.Recipe) int64 {
	dep, ok := ctx.State.Deposit(recipe.OutputProductID)
	if !ok {
		return recipe.OutputQtyCent
	}
	return recipe.OutputQtyCent * dep.YieldBps / 10000
}
