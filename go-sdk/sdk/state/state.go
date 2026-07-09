package state

import (
	"sync"
	"time"

	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/models"
)

type StateManager struct {
	sync.RWMutex
	agentID               string
	username              string
	role                  models.AgentRole
	status                models.AgentStatus
	registeredAt          time.Time
	bankruptAt            *time.Time
	capitalAvailableCents int64
	capitalReservedCents  int64

	inventory        map[string]models.InventoryPosition
	activeOrders     map[string]models.Order
	runningProcesses map[string]models.TransformationProcess
	capacities       map[string]models.CapacityStatus
	products         map[string]models.Product
	recipes          map[string]models.Recipe
	publicAgents     map[string]models.AgentPublic
}

func NewStateManager() *StateManager {
	return &StateManager{
		inventory:        make(map[string]models.InventoryPosition),
		activeOrders:     make(map[string]models.Order),
		runningProcesses: make(map[string]models.TransformationProcess),
		capacities:       make(map[string]models.CapacityStatus),
		products:         make(map[string]models.Product),
		recipes:          make(map[string]models.Recipe),
		publicAgents:     make(map[string]models.AgentPublic),
	}
}

// Rebuild completely replaces the current state with the provided snapshot.
func (s *StateManager) Rebuild(snap *models.AgentSnapshot) {
	s.Lock()
	defer s.Unlock()

	s.agentID = snap.Agent.AgentID
	s.username = snap.Agent.Username
	s.role = snap.Agent.Role
	s.status = snap.Agent.Status
	s.registeredAt = snap.Agent.RegisteredAt
	s.bankruptAt = snap.Agent.BankruptAt
	s.capitalAvailableCents = snap.CapitalAvailableCents
	s.capitalReservedCents = snap.CapitalReservedCents

	// Clear and refill maps
	s.inventory = make(map[string]models.InventoryPosition)
	for _, inv := range snap.Inventory {
		s.inventory[inv.ProductID] = inv
	}

	s.activeOrders = make(map[string]models.Order)
	for _, order := range snap.ActiveOrders {
		s.activeOrders[order.OrderID] = order
	}

	s.runningProcesses = make(map[string]models.TransformationProcess)
	for _, proc := range snap.RunningProcesses {
		s.runningProcesses[proc.ProcessID] = proc
	}

	s.capacities = make(map[string]models.CapacityStatus)
	for _, capStatus := range snap.Capacities {
		s.capacities[capStatus.RecipeID] = capStatus
	}
}

// SetCatalog sets the static catalog data.
func (s *StateManager) SetCatalog(products []models.Product, recipes []models.Recipe) {
	s.Lock()
	defer s.Unlock()

	s.products = make(map[string]models.Product)
	for _, p := range products {
		s.products[p.ProductID] = p
	}

	s.recipes = make(map[string]models.Recipe)
	for _, r := range recipes {
		s.recipes[r.RecipeID] = r
	}
}

// AddOrder manually registers a new order in the local state.
func (s *StateManager) AddOrder(order models.Order) {
	s.Lock()
	defer s.Unlock()
	s.activeOrders[order.OrderID] = order

	// Optimistically adjust reservations in the local cache
	if order.Side == models.SideBuy {
		cost := order.QtyOriginalCent * order.LimitPriceCents
		s.capitalAvailableCents -= cost
		s.capitalReservedCents += cost
	} else {
		inv, ok := s.inventory[order.ProductID]
		if ok {
			inv.QtyAvailableCent -= order.QtyOriginalCent
			inv.QtyReservedCent += order.QtyOriginalCent
			s.inventory[order.ProductID] = inv
		}
	}
}

// AddProcess manually registers a new process in the local state.
func (s *StateManager) AddProcess(proc models.TransformationProcess) {
	s.Lock()
	defer s.Unlock()
	s.runningProcesses[proc.ProcessID] = proc

	// Adjust capacities and reservations
	recipe, ok := s.recipes[proc.RecipeID]
	if ok {
		// Decrease available capacity slots
		capStatus, exists := s.capacities[proc.RecipeID]
		if exists {
			capStatus.Running += proc.ExecutionsPlanned
			capStatus.AvailableSlots -= proc.ExecutionsPlanned
			s.capacities[proc.RecipeID] = capStatus
		}

		// Subtract wages
		wage := proc.WagePaidCents
		s.capitalAvailableCents -= wage

		// Subtract inputs
		for _, input := range recipe.Inputs {
			inv, exists := s.inventory[input.ProductID]
			if exists {
				inv.QtyAvailableCent -= input.QtyRequiredCent * int64(proc.ExecutionsPlanned)
				s.inventory[input.ProductID] = inv
			}
		}
	}
}

// ApplyEvent applies a real-time event received from the WebSocket channel to synchronize state.
func (s *StateManager) ApplyEvent(ev events.Event) {
	s.Lock()
	defer s.Unlock()

	switch e := ev.(type) {
	case events.OrderExecuted:
		order, ok := s.activeOrders[e.OrderID]
		if ok {
			// Update pending quantity
			order.QtyPendingCent -= e.QtyExecutedCent
			if order.QtyPendingCent <= 0 {
				order.Status = models.OrderStatusCompleted
				delete(s.activeOrders, e.OrderID)
			} else {
				order.Status = models.OrderStatusPartial
				s.activeOrders[e.OrderID] = order
			}

			// Adjust capital/inventory
			if order.Side == models.SideBuy {
				// Buy order execution
				// Refund any difference between limit price and execution price
				limitCost := e.QtyExecutedCent * order.LimitPriceCents
				actualCost := e.QtyExecutedCent * e.PriceCents
				diff := limitCost - actualCost

				s.capitalReservedCents -= limitCost
				s.capitalAvailableCents += diff // refund extra reserved amount

				// Add to inventory
				inv := s.inventory[order.ProductID]
				inv.ProductID = order.ProductID
				inv.QtyAvailableCent += e.QtyExecutedCent
				s.inventory[order.ProductID] = inv
			} else {
				// Sell order execution
				s.capitalAvailableCents += e.QtyExecutedCent * e.PriceCents

				// Deduct from reserved inventory
				inv := s.inventory[order.ProductID]
				inv.ProductID = order.ProductID
				inv.QtyReservedCent -= e.QtyExecutedCent
				s.inventory[order.ProductID] = inv
			}
		}

	case events.OrderCancelled:
		order, ok := s.activeOrders[e.OrderID]
		if ok {
			delete(s.activeOrders, e.OrderID)
			// Return reservations to available
			if order.Side == models.SideBuy {
				cost := order.QtyPendingCent * order.LimitPriceCents
				s.capitalReservedCents -= cost
				s.capitalAvailableCents += cost
			} else {
				inv := s.inventory[order.ProductID]
				inv.QtyReservedCent -= order.QtyPendingCent
				inv.QtyAvailableCent += order.QtyPendingCent
				s.inventory[order.ProductID] = inv
			}
		}

	case events.OrderExpired:
		order, ok := s.activeOrders[e.OrderID]
		if ok {
			delete(s.activeOrders, e.OrderID)
			// Return reservations to available
			if order.Side == models.SideBuy {
				cost := order.QtyPendingCent * order.LimitPriceCents
				s.capitalReservedCents -= cost
				s.capitalAvailableCents += cost
			} else {
				inv := s.inventory[order.ProductID]
				inv.QtyReservedCent -= order.QtyPendingCent
				inv.QtyAvailableCent += order.QtyPendingCent
				s.inventory[order.ProductID] = inv
			}
		}

	case events.TransformationCompleted:
		proc, ok := s.runningProcesses[e.ProcessID]
		if ok {
			delete(s.runningProcesses, e.ProcessID)

			// Free capacity slots
			capStatus, exists := s.capacities[e.RecipeID]
			if exists {
				capStatus.Running -= proc.ExecutionsPlanned
				if capStatus.Running < 0 {
					capStatus.Running = 0
				}
				capStatus.AvailableSlots = capStatus.Installations - capStatus.Running
				s.capacities[e.RecipeID] = capStatus
			}

			// Add produced item to inventory
			recipe, recipeExists := s.recipes[e.RecipeID]
			if recipeExists {
				qtyProduced := recipe.OutputQtyCent * int64(proc.ExecutionsPlanned)
				inv := s.inventory[recipe.OutputProductID]
				inv.ProductID = recipe.OutputProductID
				inv.QtyAvailableCent += qtyProduced
				s.inventory[recipe.OutputProductID] = inv
			}
		}

	case events.BankruptcyNotice:
		if e.AgentID == s.agentID {
			s.status = models.StatusBankrupt
			now := time.Now()
			s.bankruptAt = &now
		}

	case events.AgentJoined:
		s.publicAgents[e.AgentID] = models.AgentPublic{
			AgentID:      e.AgentID,
			Username:     e.Username,
			Role:         models.AgentRole(e.Role),
			Status:       models.StatusActive,
			RegisteredAt: e.JoinedAt,
		}

	case events.AgentBankrupt:
		agent, ok := s.publicAgents[e.AgentID]
		if ok {
			agent.Status = models.StatusBankrupt
			agent.BankruptAt = &e.BankruptAt
			s.publicAgents[e.AgentID] = agent
		}
	}
}

// Getters (Thread-Safe)

func (s *StateManager) GetAgentInfo() (id string, username string, role models.AgentRole, status models.AgentStatus) {
	s.RLock()
	defer s.RUnlock()
	return s.agentID, s.username, s.role, s.status
}

func (s *StateManager) Capital() (available int64, reserved int64) {
	s.RLock()
	defer s.RUnlock()
	return s.capitalAvailableCents, s.capitalReservedCents
}

func (s *StateManager) Inventory() []models.InventoryPosition {
	s.RLock()
	defer s.RUnlock()
	res := make([]models.InventoryPosition, 0, len(s.inventory))
	for _, pos := range s.inventory {
		res = append(res, pos)
	}
	return res
}

func (s *StateManager) InventoryForProduct(productID string) models.InventoryPosition {
	s.RLock()
	defer s.RUnlock()
	pos, ok := s.inventory[productID]
	if !ok {
		return models.InventoryPosition{ProductID: productID}
	}
	return pos
}

func (s *StateManager) ActiveOrders() []models.Order {
	s.RLock()
	defer s.RUnlock()
	res := make([]models.Order, 0, len(s.activeOrders))
	for _, o := range s.activeOrders {
		res = append(res, o)
	}
	return res
}

func (s *StateManager) RunningProcesses() []models.TransformationProcess {
	s.RLock()
	defer s.RUnlock()
	res := make([]models.TransformationProcess, 0, len(s.runningProcesses))
	for _, p := range s.runningProcesses {
		res = append(res, p)
	}
	return res
}

func (s *StateManager) CatalogProducts() []models.Product {
	s.RLock()
	defer s.RUnlock()
	res := make([]models.Product, 0, len(s.products))
	for _, p := range s.products {
		res = append(res, p)
	}
	return res
}

func (s *StateManager) Product(productID string) (models.Product, bool) {
	s.RLock()
	defer s.RUnlock()
	p, ok := s.products[productID]
	return p, ok
}

func (s *StateManager) CatalogRecipes() []models.Recipe {
	s.RLock()
	defer s.RUnlock()
	res := make([]models.Recipe, 0, len(s.recipes))
	for _, r := range s.recipes {
		res = append(res, r)
	}
	return res
}

func (s *StateManager) Recipe(recipeID string) (models.Recipe, bool) {
	s.RLock()
	defer s.RUnlock()
	r, ok := s.recipes[recipeID]
	return r, ok
}

func (s *StateManager) Capacities() []models.CapacityStatus {
	s.RLock()
	defer s.RUnlock()
	res := make([]models.CapacityStatus, 0, len(s.capacities))
	for _, c := range s.capacities {
		res = append(res, c)
	}
	return res
}

func (s *StateManager) Capacity(recipeID string) (models.CapacityStatus, bool) {
	s.RLock()
	defer s.RUnlock()
	c, ok := s.capacities[recipeID]
	return c, ok
}

func (s *StateManager) PublicAgents() []models.AgentPublic {
	s.RLock()
	defer s.RUnlock()
	res := make([]models.AgentPublic, 0, len(s.publicAgents))
	for _, a := range s.publicAgents {
		res = append(res, a)
	}
	return res
}

func (s *StateManager) PublicAgent(agentID string) (models.AgentPublic, bool) {
	s.RLock()
	defer s.RUnlock()
	a, ok := s.publicAgents[agentID]
	return a, ok
}
