package strategy

import (
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
)

// ReadOnlyState defines the read-only interface of the state manager exposed to the strategy.
type ReadOnlyState interface {
	GetAgentInfo() (id string, username string, role models.AgentRole, status models.AgentStatus)
	Capital() (available int64, reserved int64)
	Inventory() []models.InventoryPosition
	InventoryForProduct(productID string) models.InventoryPosition
	ActiveOrders() []models.Order
	RunningProcesses() []models.TransformationProcess
	CatalogProducts() []models.Product
	Product(productID string) (models.Product, bool)
	ProductByKey(key string) (models.Product, bool)
	CatalogRecipes() []models.Recipe
	Recipe(recipeID string) (models.Recipe, bool)
	Capacities() []models.CapacityStatus
	Capacity(recipeID string) (models.CapacityStatus, bool)
	PublicAgents() []models.AgentPublic
	PublicAgent(agentID string) (models.AgentPublic, bool)
}

type Clock interface {
	Now() time.Time
}

type SystemClock struct{}

func (SystemClock) Now() time.Time {
	return time.Now()
}

// MarketData da acceso de solo lectura a los datos públicos del mercado
// (visibilidad nivel 1). A diferencia de ReadOnlyState — cache local sin I/O —
// cada llamada es una petición REST al servidor: úsese con moderación (p. ej.
// solo para el universo de productos que la estrategia opera activamente).
type MarketData interface {
	TopOfBook(productID string) (*models.TopOfBook, error)
	RecentTrades(productID string, q models.TradesQuery) ([]models.Trade, error)
	// BankInfo consulta la política monetaria del banco central (patrón oro).
	// La paridad y la banda bid/ask son FIJAS durante la corrida: léase una vez
	// en Initialize y cachéese; reservas y contadores sí cambian. Devuelve
	// error si la corrida no tiene patrón oro sembrado (409 no_gold_standard).
	BankInfo() (*models.BankInfo, error)
}

type Context struct {
	State  ReadOnlyState
	Logger *slog.Logger
	Rand   *rand.Rand
	Clock  Clock
	Config map[string]interface{}
	// Market es acceso REST en vivo al libro/tape públicos; puede ser nil en
	// tests que no lo inyecten.
	Market MarketData
}

type Strategy interface {
	Initialize(ctx *Context) error
	Tick(ctx *Context) []actions.Action
	HandleEvent(ctx *Context, e events.Event) []actions.Action
}
