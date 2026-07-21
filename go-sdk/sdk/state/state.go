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
	// Instalaciones compradas, keyed por installation_type (key). El nivel es el
	// presupuesto de concurrencia COMPARTIDO por las recetas del tipo (ADR-021).
	installations map[string]models.InstallationStatus
	// Catálogo de tipos comprables, keyed por installation_type_id (UUID): permite
	// mapear recipe.InstallationTypeID → key del tipo, y conocer el precio base.
	installationTypes map[string]models.InstallationType
	products          map[string]models.Product
	productsByKey     map[string]models.Product
	recipes           map[string]models.Recipe
	publicAgents      map[string]models.AgentPublic
	// Yacimientos finitos (ADR-023), keyed por product_id. NO es catálogo
	// estático: se refresca periódicamente y por la notificación
	// deposit_depleted. Un producto sin entrada aquí es inagotable.
	deposits map[string]models.Deposit

	cachedInventory        []models.InventoryPosition
	cachedActiveOrders     []models.Order
	cachedRunningProcesses []models.TransformationProcess
	cachedInstallations    []models.InstallationStatus
	cachedProducts         []models.Product
	cachedRecipes          []models.Recipe
	cachedPublicAgents     []models.AgentPublic

	inventoryDirty        bool
	activeOrdersDirty     bool
	runningProcessesDirty bool
	installationsDirty    bool
	productsDirty         bool
	recipesDirty          bool
	publicAgentsDirty     bool
}

func NewStateManager() *StateManager {
	return &StateManager{
		inventory:             make(map[string]models.InventoryPosition),
		activeOrders:          make(map[string]models.Order),
		runningProcesses:      make(map[string]models.TransformationProcess),
		installations:         make(map[string]models.InstallationStatus),
		installationTypes:     make(map[string]models.InstallationType),
		products:              make(map[string]models.Product),
		productsByKey:         make(map[string]models.Product),
		recipes:               make(map[string]models.Recipe),
		publicAgents:          make(map[string]models.AgentPublic),
		deposits:              make(map[string]models.Deposit),
		inventoryDirty:        true,
		activeOrdersDirty:     true,
		runningProcessesDirty: true,
		installationsDirty:    true,
		productsDirty:         true,
		recipesDirty:          true,
		publicAgentsDirty:     true,
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

	s.installations = make(map[string]models.InstallationStatus)
	for _, inst := range snap.Installations {
		s.installations[inst.InstallationType] = inst
	}
	s.inventoryDirty = true
	s.activeOrdersDirty = true
	s.runningProcessesDirty = true
	s.installationsDirty = true
}

// SetCatalog sets the static catalog data.
func (s *StateManager) SetCatalog(products []models.Product, recipes []models.Recipe) {
	s.Lock()
	defer s.Unlock()

	s.products = make(map[string]models.Product)
	s.productsByKey = make(map[string]models.Product)
	for _, p := range products {
		s.products[p.ProductID] = p
		if p.Key != "" {
			s.productsByKey[p.Key] = p
		}
	}

	s.recipes = make(map[string]models.Recipe)
	for _, r := range recipes {
		s.recipes[r.RecipeID] = r
	}
	s.productsDirty = true
	s.recipesDirty = true
}

// notionalCents replica el redondeo del backend: el capital que reserva/mueve
// una orden es floor(qty_cent * price_cents / 100) — qty va en centi-unidades
// y el precio en centavos POR UNIDAD.
func notionalCents(qtyCent, priceCents int64) int64 {
	return qtyCent * priceCents / 100
}

// Parámetros de fee del matching (espejo de FEE_FIXED_CENTS y FEE_RATE_BPS del
// backend). Cada lado de un trade paga fijo + floor(notional × bps / 10000)
// desde su capital disponible; sin modelarlo el capital local queda inflado y
// las órdenes siguientes revientan con 422 insufficient_capital.
const (
	feeFixedCents int64 = 5
	feeRateBps    int64 = 25
)

// estimatedFeeCents replica feeCents() del backend para un notional dado.
func estimatedFeeCents(notional int64) int64 {
	return feeFixedCents + notional*feeRateBps/10000
}

// AddOrder manually registers a new order in the local state.
func (s *StateManager) AddOrder(order models.Order) {
	s.Lock()
	defer s.Unlock()
	s.activeOrders[order.OrderID] = order
	s.activeOrdersDirty = true
	s.inventoryDirty = true

	// Optimistically adjust reservations in the local cache
	if order.Side == models.SideBuy {
		cost := notionalCents(order.QtyOriginalCent, order.LimitPriceCents)
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
	s.runningProcessesDirty = true
	s.installationsDirty = true
	s.inventoryDirty = true

	// Adjust installations and reservations
	recipe, ok := s.recipes[proc.RecipeID]
	if ok {
		// Decrease available slots of the recipe's installation type (compartido).
		if typeKey, tok := s.installationKeyForRecipeLocked(recipe); tok {
			if inst, exists := s.installations[typeKey]; exists {
				inst.Running += proc.ExecutionsPlanned
				inst.AvailableSlots -= proc.ExecutionsPlanned
				if inst.AvailableSlots < 0 {
					inst.AvailableSlots = 0
				}
				s.installations[typeKey] = inst
			}
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
		s.activeOrdersDirty = true
		s.inventoryDirty = true
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
				limitCost := notionalCents(e.QtyExecutedCent, order.LimitPriceCents)
				actualCost := notionalCents(e.QtyExecutedCent, e.PriceCents)
				diff := limitCost - actualCost

				s.capitalReservedCents -= limitCost
				s.capitalAvailableCents += diff // refund extra reserved amount

				// El fee del comprador sale del disponible (el backend lo capea
				// a available, así que este clamp mantiene el sesgo conservador).
				s.capitalAvailableCents -= estimatedFeeCents(actualCost)
				if s.capitalAvailableCents < 0 {
					s.capitalAvailableCents = 0
				}

				// Add to inventory
				inv := s.inventory[order.ProductID]
				inv.ProductID = order.ProductID
				inv.QtyAvailableCent += e.QtyExecutedCent
				s.inventory[order.ProductID] = inv
			} else {
				// Sell order execution (neto del fee del vendedor)
				proceeds := notionalCents(e.QtyExecutedCent, e.PriceCents)
				s.capitalAvailableCents += proceeds - estimatedFeeCents(proceeds)
				if s.capitalAvailableCents < 0 {
					s.capitalAvailableCents = 0
				}

				// Deduct from reserved inventory
				inv := s.inventory[order.ProductID]
				inv.ProductID = order.ProductID
				inv.QtyReservedCent -= e.QtyExecutedCent
				s.inventory[order.ProductID] = inv
			}
		}

	case events.OrderCancelled:
		s.activeOrdersDirty = true
		s.inventoryDirty = true
		order, ok := s.activeOrders[e.OrderID]
		if ok {
			delete(s.activeOrders, e.OrderID)
			// Return reservations to available
			if order.Side == models.SideBuy {
				cost := notionalCents(order.QtyPendingCent, order.LimitPriceCents)
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
		s.activeOrdersDirty = true
		s.inventoryDirty = true
		order, ok := s.activeOrders[e.OrderID]
		if ok {
			delete(s.activeOrders, e.OrderID)
			// Return reservations to available
			if order.Side == models.SideBuy {
				cost := notionalCents(order.QtyPendingCent, order.LimitPriceCents)
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
		s.runningProcessesDirty = true
		s.installationsDirty = true
		s.inventoryDirty = true
		proc, ok := s.runningProcesses[e.ProcessID]
		if ok {
			delete(s.runningProcesses, e.ProcessID)

			// Free slots of the recipe's installation type
			if recipe, rok := s.recipes[e.RecipeID]; rok {
				if typeKey, tok := s.installationKeyForRecipeLocked(recipe); tok {
					if inst, exists := s.installations[typeKey]; exists {
						inst.Running -= proc.ExecutionsPlanned
						if inst.Running < 0 {
							inst.Running = 0
						}
						inst.AvailableSlots = inst.Level - inst.Running
						s.installations[typeKey] = inst
					}
				}
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

	case events.GoldConverted:
		// Conversión propia en la ventanilla del banco (patrón oro): sin fees.
		s.inventoryDirty = true
		inv := s.inventory[e.ProductID]
		inv.ProductID = e.ProductID
		if e.Direction == string(models.SellGold) {
			inv.QtyAvailableCent -= e.QtyCent
			if inv.QtyAvailableCent < 0 {
				inv.QtyAvailableCent = 0
			}
			s.capitalAvailableCents += e.TotalCents
		} else {
			inv.QtyAvailableCent += e.QtyCent
			s.capitalAvailableCents -= e.TotalCents
			if s.capitalAvailableCents < 0 {
				s.capitalAvailableCents = 0
			}
		}
		s.inventory[e.ProductID] = inv

	case events.CityIncome:
		// Ingreso recurrente de la ciudad (flujo circular). Suma directa al
		// disponible: el servidor ya lo acreditó, esto solo mantiene el estado
		// local al día para que el siguiente tick lo gaste.
		if e.AmountCents > 0 {
			s.capitalAvailableCents += e.AmountCents
		}

	case events.InstallationPurchased:
		// Compra/mejora propia confirmada (ADR-021). El payload es el estado
		// absoluto de la instalación al commit del servidor (running incluido),
		// así que se aplica tal cual. El capital NO se toca aquí: lo rebasea el
		// resync de snapshot que dispara el engine tras la compra.
		s.installationsDirty = true
		s.installations[e.InstallationType] = models.InstallationStatus{
			InstallationType:      e.InstallationType,
			Name:                  e.Name,
			UnitLabel:             e.UnitLabel,
			Level:                 e.Level,
			Running:               e.Running,
			AvailableSlots:        e.AvailableSlots,
			NextUpgradePriceCents: e.NextUpgradePriceCents,
		}

	case events.BankruptcyNotice:
		if e.AgentID == s.agentID {
			s.status = models.StatusBankrupt
			now := time.Now()
			s.bankruptAt = &now
		}

	case events.AgentJoined:
		s.publicAgentsDirty = true
		s.publicAgents[e.AgentID] = models.AgentPublic{
			AgentID:      e.AgentID,
			Username:     e.Username,
			Role:         models.AgentRole(e.Role),
			Status:       models.StatusActive,
			RegisteredAt: e.JoinedAt,
		}

	case events.AgentBankrupt:
		s.publicAgentsDirty = true
		agent, ok := s.publicAgents[e.AgentID]
		if ok {
			agent.Status = models.StatusBankrupt
			agent.BankruptAt = &e.BankruptAt
			s.publicAgents[e.AgentID] = agent
		}

	case events.DepositDepleted:
		// Broadcast (ADR-023): el yacimiento se agotó para todo el mercado, no
		// solo para quien lo vació. Aplicarlo ya evita que la estrategia siga
		// valorando esa receta hasta el próximo refresco periódico.
		d, ok := s.deposits[e.ProductID]
		if ok {
			d.QtyRemainingCent = 0
			d.YieldBps = 0
			s.deposits[e.ProductID] = d
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
	if !s.inventoryDirty {
		res := s.cachedInventory
		s.RUnlock()
		return res
	}
	s.RUnlock()
	s.Lock()
	defer s.Unlock()
	if s.inventoryDirty {
		s.cachedInventory = make([]models.InventoryPosition, 0, len(s.inventory))
		for _, x := range s.inventory {
			s.cachedInventory = append(s.cachedInventory, x)
		}
		s.inventoryDirty = false
	}
	return s.cachedInventory
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
	if !s.activeOrdersDirty {
		res := s.cachedActiveOrders
		s.RUnlock()
		return res
	}
	s.RUnlock()
	s.Lock()
	defer s.Unlock()
	if s.activeOrdersDirty {
		s.cachedActiveOrders = make([]models.Order, 0, len(s.activeOrders))
		for _, x := range s.activeOrders {
			s.cachedActiveOrders = append(s.cachedActiveOrders, x)
		}
		s.activeOrdersDirty = false
	}
	return s.cachedActiveOrders
}

func (s *StateManager) RunningProcesses() []models.TransformationProcess {
	s.RLock()
	if !s.runningProcessesDirty {
		res := s.cachedRunningProcesses
		s.RUnlock()
		return res
	}
	s.RUnlock()
	s.Lock()
	defer s.Unlock()
	if s.runningProcessesDirty {
		s.cachedRunningProcesses = make([]models.TransformationProcess, 0, len(s.runningProcesses))
		for _, x := range s.runningProcesses {
			s.cachedRunningProcesses = append(s.cachedRunningProcesses, x)
		}
		s.runningProcessesDirty = false
	}
	return s.cachedRunningProcesses
}

func (s *StateManager) CatalogProducts() []models.Product {
	s.RLock()
	if !s.productsDirty {
		res := s.cachedProducts
		s.RUnlock()
		return res
	}
	s.RUnlock()
	s.Lock()
	defer s.Unlock()
	if s.productsDirty {
		s.cachedProducts = make([]models.Product, 0, len(s.products))
		for _, x := range s.products {
			s.cachedProducts = append(s.cachedProducts, x)
		}
		s.productsDirty = false
	}
	return s.cachedProducts
}

func (s *StateManager) Product(productID string) (models.Product, bool) {
	s.RLock()
	defer s.RUnlock()
	p, ok := s.products[productID]
	return p, ok
}

// ProductByKey resuelve un producto por su key estable del catálogo (ej.
// "trigo"), el ancla natural para configuración externa como precios base.
func (s *StateManager) ProductByKey(key string) (models.Product, bool) {
	s.RLock()
	defer s.RUnlock()
	p, ok := s.productsByKey[key]
	return p, ok
}

func (s *StateManager) CatalogRecipes() []models.Recipe {
	s.RLock()
	if !s.recipesDirty {
		res := s.cachedRecipes
		s.RUnlock()
		return res
	}
	s.RUnlock()
	s.Lock()
	defer s.Unlock()
	if s.recipesDirty {
		s.cachedRecipes = make([]models.Recipe, 0, len(s.recipes))
		for _, x := range s.recipes {
			s.cachedRecipes = append(s.cachedRecipes, x)
		}
		s.recipesDirty = false
	}
	return s.cachedRecipes
}

func (s *StateManager) Recipe(recipeID string) (models.Recipe, bool) {
	s.RLock()
	defer s.RUnlock()
	r, ok := s.recipes[recipeID]
	return r, ok
}

func (s *StateManager) Installations() []models.InstallationStatus {
	s.RLock()
	if !s.installationsDirty {
		res := s.cachedInstallations
		s.RUnlock()
		return res
	}
	s.RUnlock()
	s.Lock()
	defer s.Unlock()
	if s.installationsDirty {
		s.cachedInstallations = make([]models.InstallationStatus, 0, len(s.installations))
		for _, x := range s.installations {
			s.cachedInstallations = append(s.cachedInstallations, x)
		}
		s.installationsDirty = false
	}
	return s.cachedInstallations
}

// Installation devuelve la instalación comprada del tipo (key), si la posee.
func (s *StateManager) Installation(installationType string) (models.InstallationStatus, bool) {
	s.RLock()
	defer s.RUnlock()
	c, ok := s.installations[installationType]
	return c, ok
}

// InstallationTypeByID resuelve un tipo del catálogo por su UUID.
func (s *StateManager) InstallationTypeByID(id string) (models.InstallationType, bool) {
	s.RLock()
	defer s.RUnlock()
	t, ok := s.installationTypes[id]
	return t, ok
}

// SetInstallationTypes carga el catálogo de tipos comprables (keyed por UUID).
func (s *StateManager) SetInstallationTypes(types []models.InstallationType) {
	s.Lock()
	defer s.Unlock()
	s.installationTypes = make(map[string]models.InstallationType, len(types))
	for _, t := range types {
		s.installationTypes[t.InstallationTypeID] = t
	}
}

// SetDeposits reemplaza la vista de yacimientos finitos (ADR-023). Se llama al
// arrancar y en cada refresco: la respuesta del servidor es la verdad completa,
// así que se sustituye el mapa entero en vez de fusionar.
func (s *StateManager) SetDeposits(deposits []models.Deposit) {
	s.Lock()
	defer s.Unlock()
	s.deposits = make(map[string]models.Deposit, len(deposits))
	for _, d := range deposits {
		s.deposits[d.ProductID] = d
	}
}

// Deposit devuelve el yacimiento de un producto; ok=false si el recurso es
// inagotable (la inmensa mayoría del catálogo).
func (s *StateManager) Deposit(productID string) (models.Deposit, bool) {
	s.RLock()
	defer s.RUnlock()
	d, ok := s.deposits[productID]
	return d, ok
}

// installationKeyForRecipeLocked mapea recipe → key de su tipo de instalación.
// Requiere que el caller tenga el lock tomado.
func (s *StateManager) installationKeyForRecipeLocked(r models.Recipe) (string, bool) {
	t, ok := s.installationTypes[r.InstallationTypeID]
	if !ok {
		return "", false
	}
	return t.Key, true
}

func (s *StateManager) PublicAgents() []models.AgentPublic {
	s.RLock()
	if !s.publicAgentsDirty {
		res := s.cachedPublicAgents
		s.RUnlock()
		return res
	}
	s.RUnlock()
	s.Lock()
	defer s.Unlock()
	if s.publicAgentsDirty {
		s.cachedPublicAgents = make([]models.AgentPublic, 0, len(s.publicAgents))
		for _, x := range s.publicAgents {
			s.cachedPublicAgents = append(s.cachedPublicAgents, x)
		}
		s.publicAgentsDirty = false
	}
	return s.cachedPublicAgents
}

func (s *StateManager) PublicAgent(agentID string) (models.AgentPublic, bool) {
	s.RLock()
	defer s.RUnlock()
	a, ok := s.publicAgents[agentID]
	return a, ok
}
