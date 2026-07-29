package engine

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/auth"
	"github.com/lokiteitor/market-simulator/sdk/client"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/logging"
	"github.com/lokiteitor/market-simulator/sdk/metrics"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/scheduler"
	"github.com/lokiteitor/market-simulator/sdk/state"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
	"github.com/lokiteitor/market-simulator/sdk/websocket"
)

type Engine struct {
	sync.Mutex
	config    *Config
	logger    *slog.Logger
	metrics   metrics.Provider
	clock     strategy.Clock
	authMgr   *auth.AuthManager
	client    *client.Client
	ws        *websocket.Client
	state     *state.StateManager
	scheduler *scheduler.Scheduler
	strategy  strategy.Strategy

	ctx     context.Context
	cancel  context.CancelFunc
	running bool
	wg      sync.WaitGroup

	stratCtx   *strategy.Context
	sleepUntil time.Time

	// lowCapitalCh se cierra (una sola vez) cuando el servidor confirma
	// insufficient_capital: la señal que el runner usa en modo rotación para
	// retirar el bot y ceder su lugar al siguiente.
	lowCapitalOnce sync.Once
	lowCapitalCh   chan struct{}

	// bankruptCh se cierra (una sola vez) cuando el SERVIDOR confirma la
	// quiebra (ADR-026). A diferencia de lowCapital, es DEFINITIVA: el
	// agente no puede volver a operar ni re-loguearse, así que el runner debe
	// apagar el engine y no reintentarlo. El engine solo señala: llamar a
	// Stop() desde dentro sería un deadlock (Stop hace wg.Wait sobre el
	// eventDispatcher).
	bankruptOnce sync.Once
	bankruptCh   chan struct{}
	// lastBankruptcyCheck acota la frecuencia del sondeo al servidor (bajo el
	// mutex del engine): con 10.000 bots sin capital, un POST por tick sería un
	// martilleo inútil.
	lastBankruptcyCheck time.Time
}

var sharedTransport = &http.Transport{
	MaxIdleConns:        30000,
	MaxIdleConnsPerHost: 30000,
	IdleConnTimeout:     90 * time.Second,
}

var seedCounter uint64

func NewEngine(cfg *Config, strat strategy.Strategy, metricsProvider metrics.Provider, clock strategy.Clock) *Engine {
	if metricsProvider == nil {
		metricsProvider = &metrics.NoOpProvider{}
	}
	if clock == nil {
		clock = &strategy.SystemClock{}
	}

	logger := logging.SetupLogger(cfg.Logging)

	authMgr := auth.NewAuthManager(
		cfg.Bot.Username,
		cfg.Bot.Password,
		cfg.Bot.Role,
		cfg.Bot.PersistPath,
	)

	httpClient := &http.Client{
		Timeout:   10 * time.Second,
		Transport: sharedTransport,
	}
	restClient := client.NewClient(cfg.Server.BaseURL, httpClient, authMgr)

	authMgr.SetRefresher(func(ctx context.Context, refreshToken string) (*models.TokenPair, error) {
		return restClient.Refresh(ctx, models.RefreshRequest{RefreshToken: refreshToken})
	})
	authMgr.SetLoginHelper(restClient)

	wsClient := websocket.NewClient(cfg.Server.WSURL, authMgr, logger)
	stateMgr := state.NewStateManager()
	sched := scheduler.NewScheduler()

	seed := uint64(time.Now().UnixNano()) + atomic.AddUint64(&seedCounter, 1)

	e := &Engine{
		config:       cfg,
		logger:       logger.With("system", "engine"),
		metrics:      metricsProvider,
		clock:        clock,
		authMgr:      authMgr,
		client:       restClient,
		ws:           wsClient,
		state:        stateMgr,
		scheduler:    sched,
		strategy:     strat,
		lowCapitalCh: make(chan struct{}),
		bankruptCh:   make(chan struct{}),
	}

	e.stratCtx = &strategy.Context{
		State:  stateMgr,
		Logger: e.logger.With("system", "strategy"),
		Rand:   rand.New(rand.NewPCG(seed, 0)),
		Clock:  clock,
		Config: cfg.Strategy,
		Market: &marketData{e: e},
	}

	return e
}

// marketData adapta el cliente REST a strategy.MarketData. Usa el contexto de
// ejecución del engine cuando está corriendo (respeta la cancelación de Stop).
type marketData struct {
	e *Engine
}

func (m *marketData) runCtx() context.Context {
	m.e.Lock()
	defer m.e.Unlock()
	if m.e.ctx != nil {
		return m.e.ctx
	}
	return context.Background()
}

func (m *marketData) TopOfBook(productID string) (*models.TopOfBook, error) {
	return m.e.client.GetTopOfBook(m.runCtx(), productID)
}

func (m *marketData) RecentTrades(productID string, q models.TradesQuery) ([]models.Trade, error) {
	return m.e.client.GetRecentTrades(m.runCtx(), productID, q)
}

func (m *marketData) BankInfo() (*models.BankInfo, error) {
	return m.e.client.GetBankInfo(m.runCtx())
}

func (m *marketData) CityNeeds() (*models.CityNeeds, error) {
	return m.e.client.GetCityNeeds(m.runCtx())
}

func (e *Engine) Start(ctx context.Context) error {
	e.Lock()
	if e.running {
		e.Unlock()
		return errors.New("engine is already running")
	}
	e.ctx, e.cancel = context.WithCancel(ctx)
	e.running = true
	e.Unlock()

	e.logger.Info("starting market agent engine...")

	// 1. Authenticate (login or auto-register)
	e.logger.Info("authenticating agent...")
	err := e.authMgr.PerformAuth(e.ctx, e.client, e.config.Bot.AutoRegister)
	if err != nil {
		e.Lock()
		e.running = false
		e.Unlock()
		// 403 agent_bankrupt en el login (ADR-026): la cuenta está muerta para
		// siempre. Se señala como quiebra para que el runner retire al bot en
		// vez de reintentar el arranque en cada turno de rotación.
		if errors.Is(err, auth.ErrAgentBankrupt) {
			e.logger.Warn("login rejected: agent is bankrupt", "username", e.config.Bot.Username)
			e.markBankrupt()
		}
		return fmt.Errorf("authentication failed: %w", err)
	}

	// 2. Download catalog (products & recipes)
	e.logger.Info("downloading catalog data...")
	products, err := e.client.ListProducts(e.ctx)
	if err != nil {
		e.Lock()
		e.running = false
		e.Unlock()
		return fmt.Errorf("failed to download products catalog: %w", err)
	}

	recipes, err := e.client.ListRecipes(e.ctx, "")
	if err != nil {
		e.Lock()
		e.running = false
		e.Unlock()
		return fmt.Errorf("failed to download recipes catalog: %w", err)
	}
	e.state.SetCatalog(products, recipes)

	// Catálogo de tipos de instalación (ADR-021): para mapear
	// recipe.InstallationTypeID → key y conocer precios/límites al comprar.
	installationTypes, err := e.client.ListInstallationTypes(e.ctx)
	if err != nil {
		e.Lock()
		e.running = false
		e.Unlock()
		return fmt.Errorf("failed to download installation types catalog: %w", err)
	}
	e.state.SetInstallationTypes(installationTypes)

	// Yacimientos finitos (ADR-023). A diferencia del resto del catálogo NO son
	// estáticos, así que además de leerlos aquí hay un refresco periódico más
	// abajo. Un fallo NO aborta el arranque: sin yacimientos el bot valora las
	// recetas con su output nominal, que es exactamente el comportamiento
	// anterior a ADR-023 (conservador, no incorrecto).
	if deposits, err := e.client.ListDeposits(e.ctx); err != nil {
		e.logger.Warn("failed to download deposits catalog, assuming infinite resources", "error", err)
	} else {
		e.state.SetDeposits(deposits)
		e.logger.Info("deposits loaded", "count", len(deposits))
	}

	// 3. Download snapshot
	e.logger.Info("downloading agent snapshot...")
	snap, err := e.client.GetAgentSnapshot(e.ctx, 100)
	if err != nil {
		e.Lock()
		e.running = false
		e.Unlock()
		return fmt.Errorf("failed to download agent snapshot: %w", err)
	}
	e.state.Rebuild(snap)

	e.logger.Info("agent snapshot loaded successfully",
		"agent_id", snap.Agent.AgentID,
		"role", snap.Agent.Role,
		"status", snap.Agent.Status,
		"capital_available", snap.CapitalAvailableCents,
		"capital_reserved", snap.CapitalReservedCents,
	)

	// Defensa: el agente ya venía quebrado. En la práctica no debería llegar
	// aquí (el login de un quebrado devuelve 403), pero una sesión persistida
	// aún válida podría colarlo; se señala para que el runner lo apague.
	if snap.Agent.Status == models.StatusBankrupt {
		e.markBankrupt()
	}

	// 4. Initialize strategy
	e.logger.Info("initializing strategy...")
	stratCtx := e.newStrategyContext()
	if err := e.strategy.Initialize(stratCtx); err != nil {
		e.Lock()
		e.running = false
		e.Unlock()
		return fmt.Errorf("failed to initialize strategy: %w", err)
	}

	// 5. Declarar la suscripción de tape ANTES de conectar el WS (fan-out
	// selectivo): el servidor solo entrega trade_printed de estos productos.
	tapeProducts := []string{"*"}
	if ps, ok := e.strategy.(strategy.ProductSubscriber); ok {
		if ids := ps.SubscribedProducts(); len(ids) > 0 {
			tapeProducts = ids
		}
	}
	e.ws.SetProductSubscriptions(tapeProducts)
	e.logger.Info("tape subscription declared", "products", len(tapeProducts))

	// 6. Connect WebSocket
	e.logger.Info("starting websocket connection...")
	if err := e.ws.Start(e.ctx); err != nil {
		e.Lock()
		e.running = false
		e.Unlock()
		return fmt.Errorf("failed to start websocket client: %w", err)
	}

	// 7. Start Scheduler
	e.scheduler.Start(e.ctx)

	// 8. Schedule periodic ticks
	interval := time.Duration(e.config.Bot.TickIntervalSeconds) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	e.scheduler.SchedulePeriodic(interval, func(ctx context.Context) {
		// Confirmación de quiebra (ADR-026) ANTES del early-return por sueño:
		// el bot arruinado vive precisamente dormido por el backoff de capital,
		// así que comprobarlo después no llegaría nunca. El throttle interno
		// evita el martilleo.
		if e.atZeroLocally() {
			go e.checkBankruptcy()
		}

		e.Lock()
		sleeping := e.clock.Now().Before(e.sleepUntil)
		e.Unlock()
		if sleeping {
			return
		}
		e.logger.Debug("triggering periodic strategy tick")
		actionsList := e.strategy.Tick(e.newStrategyContext())
		e.executeActions(ctx, actionsList)
	})

	// 9. Refresco periódico de yacimientos (ADR-023). Barato (≤20 filas, cacheado
	// 5 s en el servidor) y de período largo: lo que se vigila se mueve en horas.
	depositInterval := time.Duration(e.config.Bot.DepositRefreshSeconds) * time.Second
	if depositInterval <= 0 {
		depositInterval = 5 * time.Minute
	}
	e.scheduler.SchedulePeriodic(depositInterval, func(ctx context.Context) {
		e.refreshDeposits(ctx)
	})

	// 10. Start background event dispatcher
	e.wg.Add(1)
	go e.eventDispatcher()

	e.logger.Info("engine started successfully")
	return nil
}

func (e *Engine) Stop() {
	e.Lock()
	if !e.running {
		e.Unlock()
		return
	}
	e.running = false
	if e.cancel != nil {
		e.cancel()
	}
	e.Unlock()

	e.logger.Info("stopping engine...")
	e.ws.Stop()
	e.scheduler.Stop()
	e.wg.Wait()
	e.logger.Info("engine stopped")
}

func (e *Engine) eventDispatcher() {
	defer e.wg.Done()
	for {
		select {
		case ev := <-e.ws.Events():
			// Check if it's connection reestablished
			if connEv, ok := ev.(events.WSConnected); ok {
				e.logger.Info("websocket connected/reconnected", "at", connEv.ConnectedAt)
				// Fetch snapshot asynchronusly with jitter
				go e.resyncSnapshot()
				continue
			}

			// Apply to StateManager cache
			e.state.ApplyEvent(ev)

			// Vía rápida de quiebra: el servidor la detectó por su cuenta (una
			// transición terminal disparó la evaluación reactiva) y avisa por el
			// canal personal. Sin sondeo ni throttle de por medio.
			if notice, ok := ev.(events.BankruptcyNotice); ok {
				if agentID, _, _, _ := e.state.GetAgentInfo(); notice.AgentID == agentID {
					e.markBankrupt()
				}
			}

			e.Lock()
			sleeping := e.clock.Now().Before(e.sleepUntil)
			e.Unlock()

			if !sleeping {
				stratCtx := e.newStrategyContext()
				actionsList := e.strategy.HandleEvent(stratCtx, ev)
				e.executeActions(e.ctx, actionsList)
			}

		case <-e.ctx.Done():
			return
		}
	}
}

// LowCapital devuelve un canal que se cierra la primera vez que el servidor
// confirma insufficient_capital. En modo rotación el runner lo usa para
// retirar al bot antes de que termine su período activo y ceder el lugar al
// siguiente; en modo normal basta con el backoff interno (sleepUntil).
func (e *Engine) LowCapital() <-chan struct{} {
	return e.lowCapitalCh
}

// Bankrupt devuelve un canal que se cierra la primera vez que el servidor
// confirma la quiebra del agente (ADR-026). Es terminal: el runner debe llamar
// a Stop() y NO reintentar el bot — el login de un quebrado devuelve 403.
func (e *Engine) Bankrupt() <-chan struct{} {
	return e.bankruptCh
}

// isBankrupt indica si la quiebra ya está confirmada localmente.
func (e *Engine) isBankrupt() bool {
	select {
	case <-e.bankruptCh:
		return true
	default:
		return false
	}
}

// markBankrupt cierra la señal de quiebra (idempotente).
func (e *Engine) markBankrupt() {
	e.bankruptOnce.Do(func() {
		e.logger.Warn("quiebra confirmada por el servidor: el bot debe apagarse")
		close(e.bankruptCh)
	})
}

// bankruptcyCheckInterval es la pausa mínima entre sondeos de quiebra. Se
// apoya en el backoff de capital insuficiente (mismo orden de magnitud: el bot
// está dormido esperando recuperarse) con un suelo de 60 s.
func (e *Engine) bankruptcyCheckInterval() time.Duration {
	interval := e.capitalBackoff()
	if interval < 60*time.Second {
		return 60 * time.Second
	}
	return interval
}

// checkBankruptcy pregunta al servidor si el agente está en quiebra y, si lo
// confirma, cierra la señal. Pensada para invocarse como `go e.checkBankruptcy()`
// desde el tick o desde el manejo de errores: nunca bloquea al caller.
//
// Ojo: el endpoint MUTA (aplica la quiebra si se cumple la condición), de ahí
// el throttle. Los agentes exentos (`city`, `admin`) reciben siempre
// `role_exempt` y nunca cierran la señal.
func (e *Engine) checkBankruptcy() {
	if e.isBankrupt() {
		return
	}

	e.Lock()
	now := e.clock.Now()
	if !e.lastBankruptcyCheck.IsZero() && now.Sub(e.lastBankruptcyCheck) < e.bankruptcyCheckInterval() {
		e.Unlock()
		return
	}
	e.lastBankruptcyCheck = now
	ctx := e.ctx
	e.Unlock()

	if ctx == nil {
		return
	}
	res, err := e.client.CheckBankruptcy(ctx)
	if err != nil {
		// El apagado puede cancelar el contexto con la request en vuelo.
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			e.logger.Debug("bankruptcy check aborted by shutdown", "error", err)
		} else {
			e.logger.Warn("bankruptcy check failed", "error", err)
		}
		return
	}
	if res.Bankrupt {
		e.markBankrupt()
		return
	}
	e.logger.Debug("bankruptcy check: el agente sigue vivo", "reasons", res.Reasons)
}

// atZeroLocally indica si la vista local del agente está completamente vacía:
// sin capital (disponible ni reservado), sin inventario, sin órdenes activas y
// sin procesos en curso. Es la condición §10 vista desde el cliente — motivo
// suficiente para preguntarle al servidor, que es quien decide.
func (e *Engine) atZeroLocally() bool {
	available, reserved := e.state.Capital()
	if available+reserved != 0 {
		return false
	}
	if len(e.state.ActiveOrders()) > 0 || len(e.state.RunningProcesses()) > 0 {
		return false
	}
	for _, pos := range e.state.Inventory() {
		if pos.QtyAvailableCent+pos.QtyReservedCent > 0 {
			return false
		}
	}
	return true
}

// resyncSnapshot rebasea el estado local con un snapshot fresco del servidor,
// con jitter para que un enjambre no sincronice sus requests. Se usa tras una
// reconexión del WS y cuando el servidor desmiente el capital local.
func (e *Engine) resyncSnapshot() {
	jitter := time.Duration(e.stratCtx.Rand.IntN(5000)) * time.Millisecond
	time.Sleep(jitter)
	snap, err := e.client.GetAgentSnapshot(e.ctx, 100)
	if err != nil {
		// El apagado puede cancelar el contexto con la request en vuelo.
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			e.logger.Debug("snapshot reload aborted by shutdown", "error", err)
		} else {
			e.logger.Error("failed to reload snapshot", "error", err)
		}
		return
	}
	e.state.Rebuild(snap)
	e.logger.Info("local state synchronized with server snapshot")
}

// refreshDeposits relee los yacimientos finitos (ADR-023). Best-effort: si
// falla se conserva la vista anterior, que envejece despacio.
func (e *Engine) refreshDeposits(ctx context.Context) {
	deposits, err := e.client.ListDeposits(ctx)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			e.logger.Debug("deposit refresh aborted by shutdown", "error", err)
		} else {
			e.logger.Warn("failed to refresh deposits, keeping previous view", "error", err)
		}
		return
	}
	e.state.SetDeposits(deposits)
	e.logger.Debug("deposits refreshed", "count", len(deposits))
}

// capitalBackoff es la pausa tras un insufficient_capital confirmado por el
// servidor: el bot duerme para dejar de martillar la API mientras recupera
// capital (fills de ventas, expiración de reservas, procesos que terminan).
func (e *Engine) capitalBackoff() time.Duration {
	if s := e.config.Bot.InsufficientCapitalBackoffSeconds; s > 0 {
		return time.Duration(s) * time.Second
	}
	return 60 * time.Second
}

func (e *Engine) executeActions(ctx context.Context, actionsList []actions.Action) {
	for _, action := range actionsList {
		if action == nil {
			continue
		}
		// El contexto muere en el shutdown o al expirar el período activo:
		// las acciones restantes del lote ya no pueden ejecutarse.
		if ctx.Err() != nil {
			e.logger.Debug("context cancelled, discarding remaining actions", "type", action.Type())
			return
		}
		e.logger.Info("executing action", "type", action.Type())
		var err error
		switch act := action.(type) {
		case actions.PlaceOrder:
			// Anticipación de insufficient_capital: si el nocional
			// (floor(qty×precio/100), lo que el backend reserva) no cabe en el
			// capital disponible local —o redondea a 0 centavos—, la orden de
			// compra moriría con 422; se descarta sin gastar el request.
			if act.Side == models.SideBuy {
				cost := act.QtyCent * act.LimitPriceCents / 100
				avail, _ := e.state.Capital()
				if cost < 1 || cost > avail {
					e.logger.Debug("skipping buy order: notional exceeds local available capital",
						"product_id", act.ProductID,
						"notional_cents", cost,
						"capital_available", avail)
					continue
				}
			}
			req := models.PlaceOrderRequest{
				ProductID:       act.ProductID,
				Side:            act.Side,
				QtyCent:         act.QtyCent,
				LimitPriceCents: act.LimitPriceCents,
				TTLSeconds:      act.TTLSeconds,
				ClientOrderID:   act.ClientOrderID,
			}
			var resp *models.PlaceOrderResponse
			resp, err = e.client.PlaceOrder(ctx, req)
			if err == nil {
				e.logger.Info("order placed successfully", "order_id", resp.OrderID)
				e.state.AddOrder(resp.Order)
			}
		case actions.CancelOrder:
			_, err = e.client.CancelOrder(ctx, act.OrderID)
			if err == nil {
				e.logger.Info("order cancelled successfully", "order_id", act.OrderID)
				// Optimistically update local state
				e.state.ApplyEvent(events.OrderCancelled{
					OrderID:     act.OrderID,
					CancelledAt: e.clock.Now(),
				})
			}
		case actions.StartTransformation:
			req := models.StartTransformationRequest{
				RecipeID:          act.RecipeID,
				ExecutionsPlanned: act.ExecutionsPlanned,
			}
			var resp *models.TransformationProcess
			resp, err = e.client.StartTransformation(ctx, req)
			if err == nil {
				e.logger.Info("transformation process started", "process_id", resp.ProcessID)
				e.state.AddProcess(*resp)
			}
		case actions.AcquireInstallation:
			req := models.AcquireInstallationRequest{
				InstallationType: act.InstallationType,
			}
			if act.ExpectedCurrentLevel >= 0 {
				lvl := act.ExpectedCurrentLevel
				req.ExpectedCurrentLevel = &lvl
			}
			var inst *models.AcquireInstallationResponse
			inst, err = e.client.AcquireInstallation(ctx, req)
			if err == nil {
				e.logger.Info("installation acquired/upgraded",
					"installation_type", inst.InstallationType,
					"level", inst.Level,
					"amount_cents", inst.AmountChargedCents)
				// El capital/instalaciones locales se rebasearán en el próximo
				// snapshot; forzamos un resync para reflejar la compra.
				go e.resyncSnapshot()
			}
		case actions.ConvertGold:
			req := models.ConvertGoldRequest{
				Direction: act.Direction,
				QtyCent:   act.QtyCent,
			}
			var conv *models.GoldConversion
			conv, err = e.client.ConvertGold(ctx, req)
			if err == nil {
				e.logger.Info("gold conversion executed",
					"conversion_id", conv.ConversionID,
					"direction", conv.Direction,
					"qty_cent", conv.QtyCent,
					"total_cents", conv.TotalCents)
				// El capital/inventario locales se sincronizan vía la
				// notificación gold_converted del WS (o el próximo snapshot).
			}
		case actions.Sleep:
			e.logger.Info("strategy requested sleep", "duration_seconds", act.DurationSeconds)
			e.Lock()
			e.sleepUntil = e.clock.Now().Add(time.Duration(act.DurationSeconds) * time.Second)
			e.Unlock()
		default:
			e.logger.Warn("unknown action type", "type", action.Type())
		}

		if err != nil {
			// La cancelación del contexto es un apagado normal, no un error.
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				e.logger.Debug("action aborted by context cancellation", "type", action.Type(), "error", err)
				return
			}
			// insufficient_capital confirmado por el servidor: el capital local
			// venía inflado. Dormir el backoff (cede API/CPU al resto del
			// enjambre), descartar el resto del lote (moriría igual) y rebasear
			// el estado con un snapshot fresco.
			var apiErr *client.APIError
			// agent_bankrupt (403): el servidor ya marcó al agente. Es terminal
			// —no puede operar ni re-loguearse—, así que se señala sin sondear.
			if errors.As(err, &apiErr) && apiErr.HasCode(client.CodeAgentBankrupt) {
				e.logger.Warn("agent_bankrupt confirmed by server", "type", action.Type())
				e.markBankrupt()
				return
			}
			if errors.As(err, &apiErr) && apiErr.HasCode(client.CodeInsufficientCapital) {
				backoff := e.capitalBackoff()
				e.logger.Debug("insufficient capital confirmed by server, backing off",
					"type", action.Type(), "backoff_seconds", backoff.Seconds())
				e.Lock()
				e.sleepUntil = e.clock.Now().Add(backoff)
				e.Unlock()
				e.lowCapitalOnce.Do(func() { close(e.lowCapitalCh) })
				go e.resyncSnapshot()
				// El capital local venía inflado: puede que ya no quede nada.
				// Preguntar si esto es quiebra y no solo una racha mala.
				go e.checkBankruptcy()
				return
			}
			// insufficient_inventory confirmado por el servidor: el inventario
			// local venía adelantado (drift optimista: un fill/cancel que aún no
			// procesamos, o una cancelación que falló). Rebasear con un snapshot
			// fresco y descartar el resto del lote (se computó sobre el mismo
			// estado stale y reventaría igual). Sin backoff: el inventario se
			// corrige solo al resincronizar, no hace falta dormir al bot.
			if errors.As(err, &apiErr) && apiErr.HasCode(client.CodeInsufficientInventory) {
				e.logger.Debug("insufficient inventory confirmed by server, resyncing",
					"type", action.Type())
				go e.resyncSnapshot()
				return
			}
			// resource_depleted (ADR-023): el yacimiento del recurso llegó a 0 y
			// la vista local venía vieja (se perdió el broadcast, o el bot
			// arrancó justo después). Refrescar los yacimientos deja la receta
			// marcada como muerta y la estrategia deja de intentarla; el resto
			// del lote sí puede ejecutarse (afecta a UNA receta, no al agente).
			if errors.As(err, &apiErr) && apiErr.HasCode(client.CodeResourceDepleted) {
				e.logger.Info("resource depleted confirmed by server, refreshing deposits",
					"type", action.Type())
				go e.refreshDeposits(e.ctx)
				continue
			}
			e.logger.Error("failed to execute action", "type", action.Type(), "error", err)
		}
	}
}

func (e *Engine) newStrategyContext() *strategy.Context {
	return e.stratCtx
}
