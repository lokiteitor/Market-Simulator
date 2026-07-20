package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/lokiteitor/market-simulator/sdk/engine"
	"github.com/lokiteitor/market-simulator/sdk/logging"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
	"gopkg.in/yaml.v3"
)

var quietMode bool

func logInfo(format string, v ...interface{}) {
	if !quietMode {
		log.Printf(format, v...)
	}
}

type BotRunnerConfig struct {
	Username            string           `yaml:"username"`
	Password            string           `yaml:"password"`
	Role                models.AgentRole `yaml:"role"`
	Strategy            string           `yaml:"strategy"`
	PersistPath         string           `yaml:"persist_path"`
	AutoRegister        bool             `yaml:"auto_register"`
	TickIntervalSeconds int              `yaml:"tick_interval_seconds"`
}

type GlobalConfig struct {
	Server            engine.ServerConfig `yaml:"server"`
	Logging           logging.Config      `yaml:"logging"`
	Retry             engine.RetryConfig  `yaml:"retry"`
	SimTimeFactor     float64             `yaml:"sim_time_factor"`
	MaxRecipesPerTick int                 `yaml:"max_recipes_per_tick"`
	// Backoff (segundos reales) cuando el servidor rechaza una acción con 422
	// insufficient_capital: el bot duerme y cede API/CPU al resto del enjambre.
	InsufficientCapitalBackoffSeconds int                    `yaml:"insufficient_capital_backoff_seconds"`
	MaxActive                         int                    `yaml:"max_active"`
	ActiveDuration                    string                 `yaml:"active_duration"`
	Scale                             int                    `yaml:"scale"`
	Prices                            map[string]interface{} `yaml:"prices"`
	Market                            map[string]interface{} `yaml:"market"`
	Bots                              []BotRunnerConfig      `yaml:"bots"`
}

func main() {
	configPath := flag.String("config", "config.yaml", "path to config yaml file")
	scale := flag.Int("scale", 0, "number of bots to run programmatically (ignores YAML bot list if > 0)")
	jitterSec := flag.Int("jitter", 0, "max startup jitter in seconds to spread connection load (default: 0)")
	maxActiveFlag := flag.Int("max-active", 0, "maximum number of active bots at the same time (0 = no limit)")
	activeDurationFlag := flag.String("active-duration", "", "duration a bot remains active before sleeping (e.g. 10m, 600s)")
	runnerID := flag.String("runner-id", "default", "unique identifier for this runner/machine to ensure deterministic and unique UUIDs")
	noPersist := flag.Bool("no-persist", false, "disable disk persistence (sqlite and json) and keep sessions 100% in RAM")
	quiet := flag.Bool("quiet", false, "only print a periodic summary of active bots and warn/error logs, silences individual bot lifecycle logs")
	flag.Parse()

	quietMode = *quiet
	runnerVal := *runnerID
	if runnerVal == "default" || runnerVal == "" {
		if host, err := os.Hostname(); err == nil {
			runnerVal = host
		}
	}

	// Load config
	data, err := os.ReadFile(*configPath)
	if err != nil {
		log.Fatalf("Failed to read config file %s: %v", *configPath, err)
	}

	var globalCfg GlobalConfig
	if err := yaml.Unmarshal(data, &globalCfg); err != nil {
		log.Fatalf("Failed to parse config: %v", err)
	}

	// Defaults defensivos: si no se configuran, usar los del servidor por defecto.
	if globalCfg.SimTimeFactor <= 0 {
		globalCfg.SimTimeFactor = 5 // igual al default de SIM_TIME_FACTOR en el backend
	}
	if globalCfg.MaxRecipesPerTick <= 0 {
		globalCfg.MaxRecipesPerTick = 8 // acota el fan-out cuando un agente tiene ~120 recetas
	}
	if quietMode {
		globalCfg.Logging.Level = "warn"
	}

	// Prepare list of bot configurations
	var botsToRun []BotRunnerConfig

	scaleVal := globalCfg.Scale
	if *scale > 0 {
		scaleVal = *scale
	}

	if scaleVal > 0 {
		log.Printf("Scale mode active. Generating %d bots programmatically for runner '%s'...", scaleVal, runnerVal)
		strats := []string{"primary_producer", "miner", "farmer", "transformer", "consumer", "trader"}

		// Fixed namespace UUID for deterministic UUID v5 generation
		namespace := uuid.MustParse("8c478718-9e01-4841-8870-fdf6d9c4f592")

		for i := 1; i <= scaleVal; i++ {
			// Round-robin distribution of strategies
			stratName := strats[(i-1)%len(strats)]
			role := models.AgentRole(stratName)
			if stratName == "miner" || stratName == "farmer" {
				role = "primary_producer"
			}
			data := []byte(fmt.Sprintf("%s-%s-%d", runnerVal, stratName, i))
			username := uuid.NewSHA1(namespace, data).String()

			// Los agentes nacen SIN instalaciones (ADR-021): las estrategias
			// compran/mejoran instalaciones por tipo con su capital. El fan-out
			// de recetas lo acota max_recipes_per_tick.
			persistPath := fmt.Sprintf("./sessions/%s.json", username)
			if *noPersist {
				persistPath = ""
			}
			botsToRun = append(botsToRun, BotRunnerConfig{
				Username:            username,
				Password:            "dev-password-123", // standard dev password
				Role:                role,
				Strategy:            stratName,
				PersistPath:         persistPath,
				AutoRegister:        true,
				TickIntervalSeconds: 5,
			})
		}
	} else {
		botsToRun = globalCfg.Bots
		if *noPersist {
			for i := range botsToRun {
				botsToRun[i].PersistPath = ""
			}
		}
	}

	log.Printf("Starting simulation with %d registered bots...", len(botsToRun))

	// Determine maxActive and activeDuration
	maxActive := globalCfg.MaxActive
	if *maxActiveFlag > 0 {
		maxActive = *maxActiveFlag
	}

	activeDuration := 10 * time.Minute // default
	activeDurationStr := globalCfg.ActiveDuration
	if *activeDurationFlag != "" {
		activeDurationStr = *activeDurationFlag
	}
	if activeDurationStr != "" {
		d, err := time.ParseDuration(activeDurationStr)
		if err != nil {
			log.Fatalf("Invalid active-duration '%s': %v", activeDurationStr, err)
		}
		activeDuration = d
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Seed random for startup jitter / shuffling
	r := rand.New(rand.NewSource(time.Now().UnixNano()))

	// Check if rotation mode is enabled and makes sense
	if maxActive > 0 && len(botsToRun) > maxActive {
		// Shuffle bots to distribute roles and spread load randomly
		r.Shuffle(len(botsToRun), func(i, j int) {
			botsToRun[i], botsToRun[j] = botsToRun[j], botsToRun[i]
		})

		// Setup clean OS signal handler to cancel main context
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		go func() {
			sig := <-sigChan
			log.Printf("Received signal %v. Initiating rotation shutdown...", sig)
			cancel()
		}()

		runWithRotation(ctx, botsToRun, globalCfg, maxActive, activeDuration)
		log.Println("Rotation simulation finished. Exit.")
		return
	}

	// Default behavior (no rotation)
	var wg sync.WaitGroup
	var engines []*engine.Engine
	var enginesMu sync.Mutex

	if quietMode {
		go func() {
			ticker := time.NewTicker(10 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					enginesMu.Lock()
					runningCount := len(engines)
					enginesMu.Unlock()
					log.Printf("[RESUMEN] Bots activos iniciados: %d / %d", runningCount, len(botsToRun))
				}
			}
		}()
	}

	// Create and start each bot
	for idx, botCfg := range botsToRun {
		eng := createEngine(botCfg, globalCfg)
		if eng == nil {
			continue
		}

		enginesMu.Lock()
		engines = append(engines, eng)
		enginesMu.Unlock()

		wg.Add(1)
		go func(e *engine.Engine, username string, botIdx int) {
			defer wg.Done()

			// Apply startup jitter if configured
			if *jitterSec > 0 {
				delay := time.Duration(r.Intn(*jitterSec*1000)) * time.Millisecond
				logInfo("[%s] Delaying start by %v to spread load...", username, delay)
				select {
				case <-time.After(delay):
				case <-ctx.Done():
					return
				}
			}

			logInfo("[%s] Launching bot (%d/%d)...", username, botIdx+1, len(botsToRun))
			if err := e.Start(ctx); err != nil {
				// El shutdown puede cancelar el contexto con el arranque en vuelo.
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					logInfo("[%s] Start aborted by shutdown", username)
				} else {
					log.Printf("[%s] Bot failed to start: %v", username, err)
				}
			}
		}(eng, botCfg.Username, idx)
	}

	// Wait for OS signals to stop cleanly
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-sigChan:
		log.Printf("Received signal %v. Initiating shutdown...", sig)
	case <-ctx.Done():
		log.Println("Context done. Initiating shutdown...")
	}

	cancel()

	log.Println("Stopping all active engines...")
	enginesMu.Lock()
	for _, eng := range engines {
		eng.Stop()
	}
	enginesMu.Unlock()

	// Wait for all goroutines to cleanup
	wg.Wait()
	log.Println("All bots stopped successfully. Exit.")
}

func createEngine(botCfg BotRunnerConfig, globalCfg GlobalConfig) *engine.Engine {
	var strat strategy.Strategy
	stratName := botCfg.Strategy
	if stratName == "" {
		stratName = string(botCfg.Role)
	}

	switch stratName {
	case "primary_producer":
		strat = NewPrimaryProducerStrategy()
	case "miner":
		strat = NewMinerStrategy()
	case "farmer":
		strat = NewFarmerStrategy()
	case "transformer":
		strat = NewTransformerStrategy()
	case "consumer":
		strat = NewConsumerStrategy()
	case "trader":
		strat = NewTraderStrategy()
	default:
		log.Printf("Warning: Unknown bot strategy '%s' for user '%s'. Skipping.", stratName, botCfg.Username)
		return nil
	}

	sdkCfg := &engine.Config{
		Server: globalCfg.Server,
		Bot: engine.BotConfig{
			Username:                          botCfg.Username,
			Password:                          botCfg.Password,
			Role:                              botCfg.Role,
			PersistPath:                       botCfg.PersistPath,
			AutoRegister:                      botCfg.AutoRegister,
			TickIntervalSeconds:               botCfg.TickIntervalSeconds,
			InsufficientCapitalBackoffSeconds: globalCfg.InsufficientCapitalBackoffSeconds,
		},
		Logging: globalCfg.Logging,
		Retry:   globalCfg.Retry,
		Strategy: map[string]interface{}{
			"prices":               globalCfg.Prices,
			"sim_time_factor":      globalCfg.SimTimeFactor,
			"max_recipes_per_tick": globalCfg.MaxRecipesPerTick,
			"market":               globalCfg.Market,
		},
	}

	return engine.NewEngine(sdkCfg, strat, nil, nil)
}

func runWithRotation(
	ctx context.Context,
	bots []BotRunnerConfig,
	globalCfg GlobalConfig,
	maxActive int,
	activeDuration time.Duration,
) {
	totalBots := len(bots)
	log.Printf("Starting rotation: total bots = %d, max active = %d, active duration = %v", totalBots, maxActive, activeDuration)

	// Calculate startup interval to stagger connection load
	interval := time.Duration(float64(activeDuration) / float64(maxActive))
	log.Printf("Staggered startup interval: %v", interval)

	// A map of currently active engines to manage shutdown
	activeEngines := make(map[string]*engine.Engine)
	var activeMu sync.Mutex
	var wg sync.WaitGroup

	if quietMode {
		go func() {
			ticker := time.NewTicker(10 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					activeMu.Lock()
					activeCount := len(activeEngines)
					activeMu.Unlock()
					log.Printf("[RESUMEN] Bots totales: %d | Activos concurrentemente: %d / %d | Rotación: %v", totalBots, activeCount, maxActive, activeDuration)
				}
			}
		}()
	}

	// Channel to signal shutdown to any running goroutines
	shutdownChan := make(chan struct{})

	// Helper to run a single bot for a limited duration
	runBot := func(botCfg BotRunnerConfig) {
		wg.Add(1)
		defer wg.Done()

		eng := createEngine(botCfg, globalCfg)
		if eng == nil {
			return
		}

		// Register as active
		activeMu.Lock()
		if _, exists := activeEngines[botCfg.Username]; exists {
			activeMu.Unlock()
			logInfo("[%s] Bot is already active, skipping start", botCfg.Username)
			return
		}
		activeEngines[botCfg.Username] = eng
		activeMu.Unlock()

		defer func() {
			// Unregister as active
			activeMu.Lock()
			delete(activeEngines, botCfg.Username)
			activeMu.Unlock()
		}()

		// Create a context that is cancelled after activeDuration
		botCtx, botCancel := context.WithTimeout(ctx, activeDuration)
		defer botCancel()

		logInfo("[%s] Starting active period of %v", botCfg.Username, activeDuration)
		if err := eng.Start(botCtx); err != nil {
			// El fin del turno o el shutdown pueden cancelar el contexto
			// con el arranque (auth/catálogo/snapshot) en vuelo.
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				logInfo("[%s] Start aborted by shutdown or end of active period", botCfg.Username)
			} else {
				log.Printf("[%s] Failed to start: %v", botCfg.Username, err)
			}
			return
		}

		// Wait for active duration to end, capital exhaustion or global shutdown
		select {
		case <-botCtx.Done():
			logInfo("[%s] Active period finished, stopping and going to sleep...", botCfg.Username)
		case <-eng.LowCapital():
			// log.Printf (no logInfo) para que el aviso se vea también en -quiet.
			log.Printf("[%s] Sin capital: cede su lugar en la rotación", botCfg.Username)
		case <-shutdownChan:
			logInfo("[%s] Shutdown signal received, stopping...", botCfg.Username)
		}

		// Stop the engine cleanly
		eng.Stop()
	}

	nextBotIdx := 0
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// Start the first bot immediately
	go runBot(bots[nextBotIdx])
	nextBotIdx = (nextBotIdx + 1) % totalBots

	for {
		select {
		case <-ctx.Done():
			log.Println("Rotation manager context cancelled, initiating shutdown...")
			close(shutdownChan)

			// Stop all currently active engines
			activeMu.Lock()
			log.Printf("Stopping %d active engines...", len(activeEngines))
			for _, eng := range activeEngines {
				go eng.Stop()
			}
			activeMu.Unlock()

			// Wait for all bot goroutines to finish
			wg.Wait()
			return

		case <-ticker.C:
			// Start the next bot
			botCfg := bots[nextBotIdx]
			go runBot(botCfg)
			nextBotIdx = (nextBotIdx + 1) % totalBots
		}
	}
}
