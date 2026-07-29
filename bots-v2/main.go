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
	"strconv"
	"strings"
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
// en quiebra (ADR-026). Ver botkit.BankruptStore.
const defaultBankruptFile = "./.bots-v2-bankrupt.list"

// namespaceV2: namespace UUID PROPIO de bots-v2. Es lo que permite correr v1 y
// v2 contra la misma economía a la vez: sus espacios de usernames son disjuntos,
// así que ninguna flota le roba las cuentas a la otra y las dos son comparables
// sobre el mismo mercado.
var namespaceV2 = uuid.MustParse("b2f0a1d4-6e57-4a2b-9c31-0f7a5d8e4c16")

func logInfo(format string, v ...interface{}) {
	if !quietMode {
		log.Printf(format, v...)
	}
}

// BotRunnerConfig: un bot concreto de la flota.
type BotRunnerConfig struct {
	Username            string           `yaml:"username"`
	Password            string           `yaml:"password"`
	Role                models.AgentRole `yaml:"role"`
	Oficio              string           `yaml:"oficio"`
	PersistPath         string           `yaml:"persist_path"`
	AutoRegister        bool             `yaml:"auto_register"`
	TickIntervalSeconds int              `yaml:"tick_interval_seconds"`
	// Capa del grafo del oficio: ordena el arranque (flota.go).
	Capa int `yaml:"-"`
}

type GlobalConfig struct {
	Server            engine.ServerConfig `yaml:"server"`
	Logging           logging.Config      `yaml:"logging"`
	Retry             engine.RetryConfig  `yaml:"retry"`
	SimTimeFactor     float64             `yaml:"sim_time_factor"`
	MaxRecipesPerTick int                 `yaml:"max_recipes_per_tick"`
	// Backoff (segundos reales) cuando el servidor rechaza una acción con 422
	// insufficient_capital.
	InsufficientCapitalBackoffSeconds int                    `yaml:"insufficient_capital_backoff_seconds"`
	DepositRefreshSeconds             int                    `yaml:"deposit_refresh_seconds"`
	MaxActive                         int                    `yaml:"max_active"`
	ActiveDuration                    string                 `yaml:"active_duration"`
	Scale                             int                    `yaml:"scale"`
	Prices                            map[string]interface{} `yaml:"prices"`
	Market                            map[string]interface{} `yaml:"market"`
	Bots                              []BotRunnerConfig      `yaml:"bots"`
}

func main() {
	configPath := flag.String("config", "config.yaml", "ruta del YAML de configuración")
	oficiosPath := flag.String("oficios", "oficios.yaml", "ruta del catálogo de oficios (ADR-027)")
	scale := flag.Int("scale", 0, "número de bots de la flota (ignora la lista `bots:` del YAML si > 0)")
	shardFlag := flag.String("shard", "", "porción de la flota que lanza este runner, formato i/N (ej. 0/3)")
	jitterSec := flag.Int("jitter", 30, "jitter de arranque DENTRO de cada capa, en segundos")
	maxActiveFlag := flag.Int("max-active", 0, "máximo de bots activos a la vez (0 = sin rotación)")
	activeDurationFlag := flag.String("active-duration", "", "duración del turno activo en rotación (ej. 10m)")
	runnerID := flag.String("runner-id", "default", "identificador de este runner/máquina (default: hostname)")
	noPersist := flag.Bool("no-persist", false, "no persistir sesiones en disco (todo en RAM)")
	bankruptFile := flag.String("bankrupt-file", defaultBankruptFile, "fichero de bots quebrados (ADR-026); \"\" lo desactiva")
	dryRun := flag.Bool("dry-run", false, "imprime la composición de la flota y sale, sin conectar con el servidor")
	quiet := flag.Bool("quiet", false, "solo resumen periódico y logs warn/error")
	flag.Parse()

	quietMode = *quiet
	runnerVal := *runnerID
	if runnerVal == "default" || runnerVal == "" {
		if host, err := os.Hostname(); err == nil {
			runnerVal = host
		}
	}

	data, err := os.ReadFile(*configPath)
	if err != nil {
		log.Fatalf("No se pudo leer %s: %v", *configPath, err)
	}
	var globalCfg GlobalConfig
	if err := yaml.Unmarshal(data, &globalCfg); err != nil {
		log.Fatalf("No se pudo parsear %s: %v", *configPath, err)
	}
	if globalCfg.SimTimeFactor <= 0 {
		globalCfg.SimTimeFactor = 5 // igual al default de SIM_TIME_FACTOR del backend
	}
	if globalCfg.MaxRecipesPerTick <= 0 {
		globalCfg.MaxRecipesPerTick = 8
	}
	if quietMode {
		globalCfg.Logging.Level = "warn"
	}

	oficios, err := CargarOficios(*oficiosPath)
	if err != nil {
		log.Fatalf("Catálogo de oficios inválido: %v", err)
	}

	botsToRun, err := construirFlota(globalCfg, oficios, *scale, *shardFlag, runnerVal, *noPersist)
	if err != nil {
		log.Fatalf("%v", err)
	}

	if *dryRun {
		fmt.Print(resumenDeConfigs(botsToRun, oficios))
		return
	}

	// Bots retirados por quiebra confirmada en corridas anteriores (ADR-026):
	// su login devuelve 403 agent_bankrupt para siempre, así que reintentarlos
	// solo genera ruido y carga.
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
		log.Printf("Quebrados en corridas anteriores: %d (%s). Omitidos: %d.", n, bankruptPath, omitted)
	}
	if len(botsToRun) == 0 {
		log.Fatalf("Todos los bots están en quiebra (%s). Usa otro -runner-id o borra ese fichero si has reseteado la base de datos.", bankruptPath)
	}

	log.Print(resumenDeConfigs(botsToRun, oficios))

	maxActive := globalCfg.MaxActive
	if *maxActiveFlag > 0 {
		maxActive = *maxActiveFlag
	}
	activeDuration := 10 * time.Minute
	activeDurationStr := globalCfg.ActiveDuration
	if *activeDurationFlag != "" {
		activeDurationStr = *activeDurationFlag
	}
	if activeDurationStr != "" {
		d, err := time.ParseDuration(activeDurationStr)
		if err != nil {
			log.Fatalf("active-duration inválida '%s': %v", activeDurationStr, err)
		}
		activeDuration = d
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := rand.New(rand.NewSource(time.Now().UnixNano()))

	if maxActive > 0 && len(botsToRun) > maxActive {
		r.Shuffle(len(botsToRun), func(i, j int) {
			botsToRun[i], botsToRun[j] = botsToRun[j], botsToRun[i]
		})
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		go func() {
			sig := <-sigChan
			log.Printf("Señal %v recibida. Apagando la rotación...", sig)
			cancel()
		}()
		runWithRotation(ctx, botsToRun, globalCfg, oficios, maxActive, activeDuration, bankruptStore)
		log.Println("Rotación terminada. Fin.")
		return
	}

	runSinRotacion(ctx, cancel, botsToRun, globalCfg, oficios, bankruptStore,
		time.Duration(*jitterSec)*time.Second, r)
}

// construirFlota decide qué bots lanza este proceso: modo flota (`-scale`) o la
// lista manual `bots:` del YAML.
func construirFlota(
	globalCfg GlobalConfig,
	oficios *CatalogoOficios,
	scale int,
	shardSpec string,
	runnerVal string,
	noPersist bool,
) ([]BotRunnerConfig, error) {
	scaleVal := globalCfg.Scale
	if scale > 0 {
		scaleVal = scale
	}
	if scaleVal <= 0 {
		bots := globalCfg.Bots
		if noPersist {
			for i := range bots {
				bots[i].PersistPath = ""
			}
		}
		for i := range bots {
			of, ok := oficios.Por(bots[i].Oficio)
			if !ok {
				return nil, fmt.Errorf("bot %q declara un oficio desconocido: %q", bots[i].Username, bots[i].Oficio)
			}
			bots[i].Role = of.Rol
			bots[i].Capa = of.Capa
		}
		return bots, nil
	}

	plazas, err := ComponerFlota(oficios, scaleVal)
	if err != nil {
		return nil, err
	}
	if shardSpec != "" {
		idx, total, err := parseShard(shardSpec)
		if err != nil {
			return nil, err
		}
		plazas, err = Shard(plazas, idx, total)
		if err != nil {
			return nil, err
		}
		log.Printf("Shard %d/%d: este runner lanza %d de las %d plazas de la flota.",
			idx, total, len(plazas), scaleVal)
	}

	bots := make([]BotRunnerConfig, 0, len(plazas))
	for _, plaza := range plazas {
		// El username se deriva del runner-id, el oficio y el índice GLOBAL de
		// la plaza (no el índice dentro del shard): así `--shard 0/3` y
		// `--shard 1/3` generan cuentas distintas pero la unión de los tres
		// shards es exactamente la misma flota que `-scale` sin shard.
		data := []byte(fmt.Sprintf("%s-%s-%d", runnerVal, plaza.Oficio.Key, plaza.Indice))
		username := uuid.NewSHA1(namespaceV2, data).String()
		persistPath := fmt.Sprintf("./sessions/%s.json", username)
		if noPersist {
			persistPath = ""
		}
		bots = append(bots, BotRunnerConfig{
			Username:            username,
			Password:            "dev-password-123",
			Role:                plaza.Oficio.Rol,
			Oficio:              plaza.Oficio.Key,
			Capa:                plaza.Oficio.Capa,
			PersistPath:         persistPath,
			AutoRegister:        true,
			TickIntervalSeconds: 5,
		})
	}
	return bots, nil
}

func parseShard(spec string) (int, int, error) {
	partes := strings.SplitN(spec, "/", 2)
	if len(partes) != 2 {
		return 0, 0, fmt.Errorf("shard %q: formato esperado i/N (ej. 0/3)", spec)
	}
	idx, err1 := strconv.Atoi(strings.TrimSpace(partes[0]))
	total, err2 := strconv.Atoi(strings.TrimSpace(partes[1]))
	if err1 != nil || err2 != nil || total < 1 {
		return 0, 0, fmt.Errorf("shard %q: formato esperado i/N (ej. 0/3)", spec)
	}
	return idx, total, nil
}

func resumenDeConfigs(bots []BotRunnerConfig, oficios *CatalogoOficios) string {
	plazas := make([]Plaza, 0, len(bots))
	for i, b := range bots {
		of, _ := oficios.Por(b.Oficio)
		plazas = append(plazas, Plaza{Oficio: of, Indice: i})
	}
	return ResumenFlota(plazas)
}

// createEngine monta el engine de un bot. `turno` > 0 solo en modo rotación: es
// lo que permite al productor hacer cierre ordenado antes de ceder el sitio.
func createEngine(
	botCfg BotRunnerConfig,
	globalCfg GlobalConfig,
	oficios *CatalogoOficios,
	turno time.Duration,
) *engine.Engine {
	of, ok := oficios.Por(botCfg.Oficio)
	if !ok {
		log.Printf("Aviso: oficio desconocido %q para %s. Se omite.", botCfg.Oficio, botCfg.Username)
		return nil
	}

	var strat strategy.Strategy
	switch of.Rol {
	case models.AgentRole("trader"):
		// El trader no necesita cierre ordenado: no tiene procesos en marcha y
		// sus cotizaciones expiran solas. Rotarlo es gratis.
		strat = NewTraderStrategy()
	default:
		prod := NewProducerStrategy(of, oficios)
		if turno > 0 {
			prod = prod.ConTurno(time.Now().Add(turno))
		}
		strat = prod
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

// runSinRotacion lanza toda la flota, escalonada por capa del grafo.
func runSinRotacion(
	ctx context.Context,
	cancel context.CancelFunc,
	botsToRun []BotRunnerConfig,
	globalCfg GlobalConfig,
	oficios *CatalogoOficios,
	bankruptStore *botkit.BankruptStore,
	jitterIntraCapa time.Duration,
	r *rand.Rand,
) {
	var wg sync.WaitGroup
	var engines []*engine.Engine
	var enginesMu sync.Mutex
	var bankruptMu sync.Mutex
	var bankruptCount int

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
					log.Printf("[RESUMEN] Bots iniciados: %d / %d | Quebrados: %d", runningCount, len(botsToRun), broke)
				}
			}
		}()
	}

	for idx, botCfg := range botsToRun {
		eng := createEngine(botCfg, globalCfg, oficios, 0)
		if eng == nil {
			continue
		}
		enginesMu.Lock()
		engines = append(engines, eng)
		enginesMu.Unlock()

		// Arranque escalonado por CAPA del grafo (no jitter uniforme): el agua
		// primero, la industria pesada al final. Ver RetardoDeArranque.
		var jitter time.Duration
		if jitterIntraCapa > 0 {
			jitter = time.Duration(r.Int63n(int64(jitterIntraCapa)))
		}
		retardo := RetardoDeArranque(oficios.Flota, botCfg.Capa, jitter)

		wg.Add(1)
		go func(e *engine.Engine, cfg BotRunnerConfig, botIdx int, espera time.Duration) {
			defer wg.Done()
			if espera > 0 {
				select {
				case <-time.After(espera):
				case <-ctx.Done():
					return
				}
			}
			logInfo("[%s] Arrancando %s (capa %d, %d/%d)...", cfg.Username, cfg.Oficio, cfg.Capa, botIdx+1, len(botsToRun))
			if err := e.Start(ctx); err != nil {
				switch {
				case errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded):
					logInfo("[%s] Arranque abortado por el apagado", cfg.Username)
				case errors.Is(err, auth.ErrAgentBankrupt):
					onBankrupt(cfg.Username)
				default:
					log.Printf("[%s] Fallo al arrancar: %v", cfg.Username, err)
				}
				return
			}
			// Start no bloquea: esta goroutine se queda de vigilante. La quiebra
			// es el único motivo por el que un bot muere antes que el proceso.
			select {
			case <-e.Bankrupt():
				e.Stop()
				onBankrupt(cfg.Username)
			case <-ctx.Done():
			}
		}(eng, botCfg, idx, retardo)
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-sigChan:
		log.Printf("Señal %v recibida. Apagando...", sig)
	case <-ctx.Done():
		log.Println("Contexto cancelado. Apagando...")
	}
	cancel()

	log.Println("Parando todos los engines activos...")
	enginesMu.Lock()
	for _, eng := range engines {
		eng.Stop()
	}
	enginesMu.Unlock()
	wg.Wait()
	log.Println("Todos los bots parados. Fin.")
}

// runWithRotation: turnos de `activeDuration` con como mucho `maxActive` bots
// conectados a la vez.
//
// Diferencia con bots-v1: la rotación es CONSCIENTE DEL OFICIO. Un trader puede
// entrar y salir sin coste —sus órdenes expiran solas y no tiene nada en
// marcha—, pero arrancar a un productor a mitad de turno lo deja con procesos
// corriendo que nadie va a materializar hasta su próximo turno y con bids vivos
// que inmovilizan su capital. Por eso los productores hacen `cierre ordenado`:
// dejan de arrancar procesos nuevos en el último tramo del turno.
func runWithRotation(
	ctx context.Context,
	bots []BotRunnerConfig,
	globalCfg GlobalConfig,
	oficios *CatalogoOficios,
	maxActive int,
	activeDuration time.Duration,
	bankruptStore *botkit.BankruptStore,
) {
	totalBots := len(bots)
	log.Printf("Rotación: %d bots, máximo %d activos, turnos de %v", totalBots, maxActive, activeDuration)

	interval := time.Duration(float64(activeDuration) / float64(maxActive))
	log.Printf("Intervalo de arranque escalonado: %v", interval)

	activeEngines := make(map[string]*engine.Engine)
	var activeMu sync.Mutex
	var wg sync.WaitGroup
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
					log.Printf("[RESUMEN] Totales: %d | Activos: %d / %d | Quebrados: %d | Turno: %v",
						totalBots, activeCount, maxActive, bankruptTotal(), activeDuration)
				}
			}
		}()
	}

	shutdownChan := make(chan struct{})

	runBot := func(botCfg BotRunnerConfig) {
		wg.Add(1)
		defer wg.Done()

		eng := createEngine(botCfg, globalCfg, oficios, activeDuration)
		if eng == nil {
			return
		}
		activeMu.Lock()
		if _, exists := activeEngines[botCfg.Username]; exists {
			activeMu.Unlock()
			logInfo("[%s] Ya está activo, no se relanza", botCfg.Username)
			return
		}
		activeEngines[botCfg.Username] = eng
		activeMu.Unlock()
		defer func() {
			activeMu.Lock()
			delete(activeEngines, botCfg.Username)
			activeMu.Unlock()
		}()

		botCtx, botCancel := context.WithTimeout(ctx, activeDuration)
		defer botCancel()

		logInfo("[%s] Turno de %v (%s)", botCfg.Username, activeDuration, botCfg.Oficio)
		if err := eng.Start(botCtx); err != nil {
			switch {
			case errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded):
				logInfo("[%s] Arranque abortado por fin de turno o apagado", botCfg.Username)
			case errors.Is(err, auth.ErrAgentBankrupt):
				// El servidor lo quebró mientras dormía entre turnos: es una
				// baja, no un fallo de arranque.
				n := markBankrupt(botCfg.Username)
				log.Printf("[%s] Quiebra confirmada en el login: fuera de la rotación (%d/%d)", botCfg.Username, n, totalBots)
			default:
				log.Printf("[%s] Fallo al arrancar: %v", botCfg.Username, err)
			}
			return
		}

		select {
		case <-botCtx.Done():
			logInfo("[%s] Turno terminado, a dormir", botCfg.Username)
		case <-eng.Bankrupt():
			// A diferencia de LowCapital, esto NO es ceder el turno: el bot sale
			// de la rotación para siempre (ADR-026).
			n := markBankrupt(botCfg.Username)
			log.Printf("[%s] Quiebra confirmada por el servidor: fuera de la rotación (%d/%d)", botCfg.Username, n, totalBots)
		case <-eng.LowCapital():
			log.Printf("[%s] Sin capital: cede su lugar en la rotación", botCfg.Username)
		case <-shutdownChan:
			logInfo("[%s] Apagado, parando...", botCfg.Username)
		}
		eng.Stop()
	}

	nextBotIdx := 0
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	go runBot(bots[nextBotIdx])
	nextBotIdx = (nextBotIdx + 1) % totalBots

	for {
		select {
		case <-ctx.Done():
			log.Println("Rotación cancelada, apagando...")
			close(shutdownChan)
			activeMu.Lock()
			log.Printf("Parando %d engines activos...", len(activeEngines))
			for _, eng := range activeEngines {
				go eng.Stop()
			}
			activeMu.Unlock()
			wg.Wait()
			return

		case <-ticker.C:
			// Siguiente bot NO quebrado; como mucho una vuelta completa.
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
