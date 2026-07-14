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
		config:    cfg,
		logger:    logger.With("system", "engine"),
		metrics:   metricsProvider,
		clock:     clock,
		authMgr:   authMgr,
		client:    restClient,
		ws:        wsClient,
		state:     stateMgr,
		scheduler: sched,
		strategy:  strat,
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
	err := e.authMgr.PerformAuth(e.ctx, e.client, e.config.Bot.AutoRegister, e.config.Bot.RequestedCapacities)
	if err != nil {
		e.Lock()
		e.running = false
		e.Unlock()
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

	// 4. Initialize strategy
	e.logger.Info("initializing strategy...")
	stratCtx := e.newStrategyContext()
	if err := e.strategy.Initialize(stratCtx); err != nil {
		e.Lock()
		e.running = false
		e.Unlock()
		return fmt.Errorf("failed to initialize strategy: %w", err)
	}

	// 5. Connect WebSocket
	e.logger.Info("starting websocket connection...")
	if err := e.ws.Start(e.ctx); err != nil {
		e.Lock()
		e.running = false
		e.Unlock()
		return fmt.Errorf("failed to start websocket client: %w", err)
	}

	// 6. Start Scheduler
	e.scheduler.Start(e.ctx)

	// 7. Schedule periodic ticks
	interval := time.Duration(e.config.Bot.TickIntervalSeconds) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	e.scheduler.SchedulePeriodic(interval, func(ctx context.Context) {
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

	// 8. Start background event dispatcher
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
				go func() {
					jitter := time.Duration(e.stratCtx.Rand.IntN(5000)) * time.Millisecond
					time.Sleep(jitter)
					snap, err := e.client.GetAgentSnapshot(e.ctx, 100)
					if err != nil {
						// El apagado puede cancelar el contexto con la request en vuelo.
						if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
							e.logger.Debug("snapshot reload aborted by shutdown", "error", err)
						} else {
							e.logger.Error("failed to reload snapshot on websocket reconnect", "error", err)
						}
					} else {
						e.state.Rebuild(snap)
						e.logger.Info("local state synchronized with server snapshot")
					}
				}()
				continue
			}

			// Apply to StateManager cache
			e.state.ApplyEvent(ev)
			
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
			e.logger.Error("failed to execute action", "type", action.Type(), "error", err)
		}
	}
}

func (e *Engine) newStrategyContext() *strategy.Context {
	return e.stratCtx
}
