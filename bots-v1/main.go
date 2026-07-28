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
	"github.com/lokiteitor/market-simulator/sdk/auth"
	"github.com/lokiteitor/market-simulator/sdk/botkit"
	"github.com/lokiteitor/market-simulator/sdk/engine"
	"github.com/lokiteitor/market-simulator/sdk/logging"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
	"gopkg.in/yaml.v3"
)

var quietMode bool

// defaultBankruptFile: registro en disco de los bots que el servidor confirmó
// en quiebra (ADR-026). Ver botkit.BankruptStore para el porqué.
const defaultBankruptFile = "./.bots-v1-bankrupt.list"

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
	InsufficientCapitalBackoffSeconds int `yaml:"insufficient_capital_backoff_seconds"`
	// Cada cuánto se releen los yacimientos finitos (ADR-023). 0 = default del
	// SDK (300 s).
	DepositRefreshSeconds int                    `yaml:"deposit_refresh_seconds"`
	MaxActive             int                    `yaml:"max_active"`
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
	bankruptFile := flag.String("bankrupt-file", defaultBankruptFile, "file where confirmed-bankrupt bots are recorded so they are not retried across restarts (ADR-026); \"\" disables it")
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
		// Especialidades productoras (ADR-022): reparten los 17 tipos de
		// instalación entre bots. El aguador está primero porque el agua es la
		// raíz de la cadena: sin él no arranca nada; el energético (ADR-024)
		// va justo después porque la industria entera consume electricidad.
		// No hay `consumer` (ADR-025): la demanda final la ponen las ciudades
		// desde bots-ciudad, que sí tienen ingreso recurrente; un consumidor
		// aquí solo gastaría su capital semilla hasta quebrar.
		strats := []string{"aguador", "energetico", "miner", "farmer", "transformer", "trader"}

		// Fixed namespace UUID for deterministic UUID v5 generation
		namespace := uuid.MustParse("8c478718-9e01-4841-8870-fdf6d9c4f592")

		for i := 1; i <= scaleVal; i++ {
			// Round-robin distribution of strategies
			stratName := strats[(i-1)%len(strats)]
			// Un solo rol productivo (ADR-022): las especialidades productoras
			// se registran todas como `transformer`.
			role := models.AgentRole(stratName)
			if stratName == "aguador" || stratName == "energetico" || stratName == "miner" || stratName == "farmer" {
				role = "transformer"
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

	// Bots retirados por quiebra confirmada en corridas anteriores (ADR-026).
	// Su login devuelve 403 agent_bankrupt para siempre, así que reintentarlos
	// solo genera ruido y carga: se sacan de la lista antes de crear engines.
	//
	// A propósito NO depende de -no-persist: ese flag evita los 10.000 ficheros
	// de sesión del enjambre, y este es UN fichero de unas pocas líneas. Es
	// justo en el enjambre (que además pierde las sesiones en cada reinicio)
	// donde más falta hace. Para desactivarlo: -bankrupt-file "".
	bankruptPath := *bankruptFile
	bankruptStore, err := botkit.NewBankruptStore(bankruptPath)
	if err != nil {
		log.Printf("Aviso: no se pudo cargar el registro de quebrados (%v). Se arranca con la lista vacía.", err)
	}
	if n := bankruptStore.Total(); n > 0 {
		live := botsToRun[:0]
		for _, botCfg := range botsToRun {
			if bankruptStore.Has(botCfg.Username) {
				continue
			}
			live = append(live, botCfg)
		}
		omitted := len(botsToRun) - len(live)
		botsToRun = live
		log.Printf("Quebrados en corridas anteriores: %d (%s). Omitidos de esta corrida: %d.", n, bankruptPath, omitted)
	}
	if len(botsToRun) == 0 {
		log.Fatalf("Todos los bots están en quiebra (%s). Usa otro -runner-id o borra ese fichero si has reseteado la base de datos.", bankruptPath)
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

		runWithRotation(ctx, botsToRun, globalCfg, maxActive, activeDuration, bankruptStore)
		log.Println("Rotation simulation finished. Exit.")
		return
	}

	// Default behavior (no rotation)
	var wg sync.WaitGroup
	var engines []*engine.Engine
	var enginesMu sync.Mutex

	// Bots retirados por quiebra confirmada (ADR-026). No se reintentan: el
	// login de un quebrado devuelve 403 agent_bankrupt. La baja se persiste
	// para que el próximo arranque tampoco los intente.
	var bankruptMu sync.Mutex
	var bankruptCount int

	// onBankrupt contabiliza la baja y, si ya no queda ningún bot vivo, cancela
	// el contexto raíz: el proceso no tiene nada más que hacer.
	onBankrupt := func(username string) {
		enginesMu.Lock()
		total := len(engines)
		enginesMu.Unlock()

		bankruptMu.Lock()
		bankruptCount++
		n := bankruptCount
		bankruptMu.Unlock()

		if _, err := bankruptStore.Add(username); err != nil {
			log.Printf("[%s] No se pudo persistir la quiebra: %v", username, err)
		}

		// log.Printf (no logInfo) para que la baja se vea también en -quiet.
		log.Printf("[%s] Quiebra confirmada por el servidor: bot retirado (%d/%d)", username, n, total)
		if n >= total {
			log.Println("Todos los bots están en quiebra. Terminando.")
			cancel()
		}
	}

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
					bankruptMu.Lock()
					broke := bankruptCount
					bankruptMu.Unlock()
					log.Printf("[RESUMEN] Bots activos iniciados: %d / %d | Quebrados: %d", runningCount, len(botsToRun), broke)
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
				switch {
				case errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded):
					logInfo("[%s] Start aborted by shutdown", username)
				case errors.Is(err, auth.ErrAgentBankrupt):
					// El login lo rechazó por quiebra: es una baja, no un fallo.
					onBankrupt(username)
				default:
					log.Printf("[%s] Bot failed to start: %v", username, err)
				}
				return
			}

			// Start no bloquea (el trabajo lo hacen el scheduler y el dispatcher
			// del engine), así que esta goroutine se queda de vigilante: la
			// quiebra es el único motivo por el que un bot muere antes que el
			// proceso. El apagado global lo maneja el Stop() del shutdown.
			select {
			case <-e.Bankrupt():
				e.Stop()
				onBankrupt(username)
			case <-ctx.Done():
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
	case "aguador":
		strat = NewAguadorStrategy()
	case "energetico":
		strat = NewEnergeticoStrategy()
	case "miner":
		strat = NewMinerStrategy()
	case "farmer":
		strat = NewFarmerStrategy()
	case "transformer":
		strat = NewTransformerStrategy()
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
			DepositRefreshSeconds:             globalCfg.DepositRefreshSeconds,
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
	bankruptStore *botkit.BankruptStore,
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

	// Bots retirados por quiebra (ADR-026): salen de la rotación para siempre,
	// porque el login de un quebrado devuelve 403 agent_bankrupt. El store lo
	// persiste en disco, así que "para siempre" sobrevive al reinicio del
	// runner (los ya quebrados ni siquiera llegaron a esta lista: main los
	// filtró antes de crear engines).
	//
	// Los contadores son de ESTA corrida (el store acumula también las
	// anteriores), para que el "n/totalBots" de los logs siga cuadrando.
	var bankruptMu sync.Mutex
	bankruptRun := 0

	isBankrupt := bankruptStore.Has
	markBankrupt := func(username string) int {
		if _, err := bankruptStore.Add(username); err != nil {
			log.Printf("[%s] No se pudo persistir la quiebra: %v", username, err)
		}
		bankruptMu.Lock()
		defer bankruptMu.Unlock()
		bankruptRun++
		return bankruptRun
	}
	bankruptTotal := func() int {
		bankruptMu.Lock()
		defer bankruptMu.Unlock()
		return bankruptRun
	}

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
					log.Printf("[RESUMEN] Bots totales: %d | Activos concurrentemente: %d / %d | Quebrados: %d | Rotación: %v", totalBots, activeCount, maxActive, bankruptTotal(), activeDuration)
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
			switch {
			case errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded):
				logInfo("[%s] Start aborted by shutdown or end of active period", botCfg.Username)
			case errors.Is(err, auth.ErrAgentBankrupt):
				// El servidor lo quebró mientras dormía entre turnos (la
				// expiración de una orden o el fin de un proceso disparan
				// checkAndApply sin el bot conectado): es una baja, no un
				// fallo de arranque. Sale de la rotación para siempre.
				n := markBankrupt(botCfg.Username)
				log.Printf("[%s] Quiebra confirmada en el login: fuera de la rotación (%d/%d)", botCfg.Username, n, totalBots)
			default:
				log.Printf("[%s] Failed to start: %v", botCfg.Username, err)
			}
			return
		}

		// Wait for active duration to end, capital exhaustion, bankruptcy or
		// global shutdown
		select {
		case <-botCtx.Done():
			logInfo("[%s] Active period finished, stopping and going to sleep...", botCfg.Username)
		case <-eng.Bankrupt():
			// A diferencia de LowCapital, esto NO es ceder el turno: el bot sale
			// de la rotación para siempre (ADR-026).
			n := markBankrupt(botCfg.Username)
			log.Printf("[%s] Quiebra confirmada por el servidor: fuera de la rotación (%d/%d)", botCfg.Username, n, totalBots)
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
			// Elegir el siguiente bot NO quebrado. Se recorre como mucho una
			// vuelta completa: si todos han quebrado no queda nada que rotar y
			// el proceso termina.
			var botCfg BotRunnerConfig
			found := false
			for i := 0; i < totalBots; i++ {
				candidate := bots[nextBotIdx]
				nextBotIdx = (nextBotIdx + 1) % totalBots
				if !isBankrupt(candidate.Username) {
					botCfg = candidate
					found = true
					break
				}
			}
			if !found {
				log.Println("Todos los bots están en quiebra. Terminando la rotación.")
				close(shutdownChan)
				wg.Wait()
				return
			}
			go runBot(botCfg)
		}
	}
}
