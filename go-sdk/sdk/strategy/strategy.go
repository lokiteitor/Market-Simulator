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

type Context struct {
	State  ReadOnlyState
	Logger *slog.Logger
	Rand   *rand.Rand
	Clock  Clock
	Config map[string]interface{}
}

type Strategy interface {
	Initialize(ctx *Context) error
	Tick(ctx *Context) []actions.Action
	HandleEvent(ctx *Context, e events.Event) []actions.Action
}
