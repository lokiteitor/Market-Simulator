// bots-hidro lanza un parque de generadores hidroeléctricos: bots que solo
// compran agua, la turbinan y venden electricidad (ADR-024).
//
// Es un binario aparte de bots-v1 —y no una especialidad más— porque el
// `energetico` de bots-v1 se queda con el tipo `generacion` ENTERO y reparte el
// nivel de la instalación entre la hidro y las dos térmicas; a partir del nivel
// 2 las líneas nuevas se van a las térmicas, que son más baratas por kWh. La
// capacidad renovable acaba siendo un residuo del arranque. Aquí el 100% del
// nivel es hidro, así que el parque renovable se dimensiona a propósito. Ver el
// comentario de HidroStrategy para el porqué económico (carbón y gas salen de
// yacimientos finitos, ADR-023: cuando se agoten, la hidro es lo único que
// queda encendido).
//
// A diferencia de bots-ciudad NO es de instancia única: los usernames se
// derivan de --runner-id con UUID v5, así que el parque se puede repartir entre
// varias máquinas sin que dos procesos peleen por la misma cuenta. Y a
// diferencia de bots-v1 no hay rotación: una central que se apaga cada pocos
// minutos no es una central. La industria consume electricidad de forma
// continua, y estos bots están para estar encendidos.
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
	"gopkg.in/yaml.v3"
)

// GlobalConfig refleja bots-hidro/config.yaml. Reutiliza los tipos del SDK
// (mismos yaml tags que bots-v1) para server/logging/retry.
type GlobalConfig struct {
	Server                            engine.ServerConfig `yaml:"server"`
	Logging                           logging.Config      `yaml:"logging"`
	Retry                             engine.RetryConfig  `yaml:"retry"`
	SimTimeFactor                     float64             `yaml:"sim_time_factor"`
	InsufficientCapitalBackoffSeconds int                 `yaml:"insufficient_capital_backoff_seconds"`
	DepositRefreshSeconds             int                 `yaml:"deposit_refresh_seconds"`
	TickIntervalSeconds               int                 `yaml:"tick_interval_seconds"`
	Scale                             int                 `yaml:"scale"`
	Password                          string              `yaml:"password"`
	// Parámetros propios de la estrategia hidro (todos opcionales; defaults en
	// hidro.go). `insumos_renovables` es la lista blanca de keys de producto que
	// una receta de generación puede consumir para contar como renovable.
	TipoInstalacion    string   `yaml:"tipo_instalacion"`
	InsumosRenovables  []string `yaml:"insumos_renovables"`
	MaxDesiredLevel    int      `yaml:"max_desired_level"`
	InventarioMaxExecs int      `yaml:"inventario_max_execs"`

	Market map[string]interface{} `yaml:"market"`
	Prices map[string]interface{} `yaml:"prices"`
}

// sessionsDir guarda la sesión (SQLite/JSON) de cada central. Se conserva entre
// reinicios para reutilizar la cadena de refresh tokens (de un solo uso).
const sessionsDir = "sessions"

// defaultBankruptFile: registro en disco de las centrales que el servidor
// confirmó en quiebra (ADR-026). Sin él, cada reinicio del runner reintentaría
// cuentas muertas cuyo login devuelve 403 agent_bankrupt para siempre. Ver
// botkit.BankruptStore.
const defaultBankruptFile = "./.bots-hidro-bankrupt.list"

// namespaceHidro: espacio de nombres PROPIO para los UUID v5 de las cuentas.
// Distinto del de bots-v1 a propósito: con el mismo namespace, un
// `bots-hidro -runner-id X` y un `bots-v1 -runner-id X` podrían derivar el mismo
// username y los dos procesos se rotarían el refresh token mutuamente.
var namespaceHidro = uuid.MustParse("6f2b1e5c-8d34-4a67-9c21-0b7f5a3e91d4")

var quietMode bool

func logInfo(format string, v ...interface{}) {
	if !quietMode {
		log.Printf(format, v...)
	}
}

func main() {
	configPath := flag.String("config", "config.yaml", "ruta al config yaml")
	scaleFlag := flag.Int("scale", 0, "número de centrales a lanzar (0 = el `scale` del config)")
	jitterSec := flag.Int("jitter", 0, "jitter máximo de arranque en segundos, para repartir la carga de conexión")
	runnerID := flag.String("runner-id", "default", "identificador de esta máquina; deriva los usernames (UUID v5)")
	noPersist := flag.Bool("no-persist", false, "no persistir sesiones en disco (todo en RAM)")
	bankruptFile := flag.String("bankrupt-file", defaultBankruptFile, "fichero donde se anotan las centrales quebradas para no reintentarlas tras un reinicio (ADR-026); \"\" lo desactiva")
	quiet := flag.Bool("quiet", false, "solo resumen periódico y logs de warn/error")
	flag.Parse()

	quietMode = *quiet
	runnerVal := *runnerID
	if runnerVal == "default" || runnerVal == "" {
		if host, err := os.Hostname(); err == nil {
			runnerVal = host
		}
	}

	cfg, err := loadConfig(*configPath)
	if err != nil {
		log.Fatalf("no se pudo cargar el config %s: %v", *configPath, err)
	}
	if cfg.SimTimeFactor <= 0 {
		cfg.SimTimeFactor = 5 // igual al default de SIM_TIME_FACTOR en el backend
	}
	if cfg.TickIntervalSeconds <= 0 {
		cfg.TickIntervalSeconds = 5
	}
	if cfg.Password == "" {
		cfg.Password = "dev-password-123"
	}
	if quietMode {
		cfg.Logging.Level = "warn"
	}

	scale := cfg.Scale
	if *scaleFlag > 0 {
		scale = *scaleFlag
	}
	if scale <= 0 {
		log.Fatal("scale <= 0: no hay centrales que lanzar (usa -scale o `scale` en el config)")
	}

	// El directorio de sesiones no se versiona, así que en un clone limpio no
	// existe: sin él el SDK no puede abrir el fichero de sesión.
	if !*noPersist {
		if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
			log.Fatalf("no se pudo crear el directorio de sesiones %s: %v", sessionsDir, err)
		}
	}

	// Centrales retiradas por quiebra confirmada en corridas anteriores
	// (ADR-026): su login devuelve 403 agent_bankrupt para siempre, así que se
	// descartan antes de crear engines en vez de reintentarlas a cada arranque.
	// No depende de -no-persist (ese flag evita los ficheros de sesión por bot;
	// este es UNO de unas pocas líneas). Para desactivarlo: -bankrupt-file "".
	bankruptPath := *bankruptFile
	bankruptStore, err := botkit.NewBankruptStore(bankruptPath)
	if err != nil {
		log.Printf("aviso: no se pudo cargar el registro de quebradas (%v); se arranca con la lista vacía", err)
	}
	usernames := make([]string, 0, scale)
	for i := 1; i <= scale; i++ {
		username := uuid.NewSHA1(namespaceHidro, []byte(fmt.Sprintf("%s-hidro-%d", runnerVal, i))).String()
		if bankruptStore.Has(username) {
			continue
		}
		usernames = append(usernames, username)
	}
	if omitidas := scale - len(usernames); omitidas > 0 {
		log.Printf("quebradas en corridas anteriores: %d (%s); omitidas de esta corrida: %d", bankruptStore.Total(), bankruptPath, omitidas)
	}
	if len(usernames) == 0 {
		log.Fatalf("todas las centrales están en quiebra (%s): usa otro -runner-id o borra ese fichero si has reseteado la base de datos", bankruptPath)
	}
	vivas := len(usernames)

	log.Printf("bots-hidro: lanzando %d centrales hidroeléctricas (runner %q)", vivas, runnerVal)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	r := rand.New(rand.NewSource(time.Now().UnixNano()))

	var wg sync.WaitGroup
	var enginesMu sync.Mutex
	engines := make([]*engine.Engine, 0, vivas)

	// Centrales retiradas por quiebra confirmada (ADR-026). No se reintentan: el
	// login de un agente quebrado devuelve 403 agent_bankrupt. El contador es de
	// ESTA corrida; la baja se persiste para las siguientes.
	var quiebraMu sync.Mutex
	quebradas := 0

	onQuiebra := func(username string) {
		if _, err := bankruptStore.Add(username); err != nil {
			log.Printf("[%s] no se pudo persistir la quiebra: %v", username, err)
		}
		quiebraMu.Lock()
		quebradas++
		n := quebradas
		quiebraMu.Unlock()
		// log.Printf (no logInfo) para que la baja se vea también en -quiet.
		log.Printf("[%s] quiebra confirmada por el servidor: central retirada (%d/%d)", username, n, vivas)
		if n >= vivas {
			log.Println("Todas las centrales están en quiebra. Terminando.")
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
					iniciadas := len(engines)
					enginesMu.Unlock()
					quiebraMu.Lock()
					rotas := quebradas
					quiebraMu.Unlock()
					log.Printf("[RESUMEN] Centrales iniciadas: %d / %d | Quebradas: %d", iniciadas, vivas, rotas)
				}
			}
		}()
	}

	for i, username := range usernames {
		eng := createEngine(username, cfg, *noPersist)

		enginesMu.Lock()
		engines = append(engines, eng)
		enginesMu.Unlock()

		wg.Add(1)
		go func(e *engine.Engine, username string, idx int) {
			defer wg.Done()

			if *jitterSec > 0 {
				delay := time.Duration(r.Intn(*jitterSec*1000)) * time.Millisecond
				select {
				case <-time.After(delay):
				case <-ctx.Done():
					return
				}
			}

			logInfo("[%s] arrancando central (%d/%d)...", username, idx, vivas)
			if err := e.Start(ctx); err != nil {
				switch {
				case errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded):
					logInfo("[%s] arranque abortado por el apagado", username)
				case errors.Is(err, auth.ErrAgentBankrupt):
					// El servidor la quebró mientras el runner estaba parado:
					// es una baja, no un fallo de arranque.
					onQuiebra(username)
				default:
					// Aquí cae también el catálogo sin receta renovable: la
					// estrategia aborta Initialize a propósito.
					log.Printf("[%s] no arrancó: %v", username, err)
				}
				return
			}

			// Start no bloquea (el trabajo lo hacen el scheduler y el dispatcher
			// del engine): esta goroutine se queda de vigilante. Sin rotación, la
			// quiebra es lo único que apaga una central antes que el proceso.
			select {
			case <-e.Bankrupt():
				e.Stop()
				onQuiebra(username)
			case <-ctx.Done():
			}
		}(eng, username, i+1)
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-sigChan:
		log.Printf("señal %v recibida, apagando...", sig)
	case <-ctx.Done():
	}

	cancel()
	log.Println("deteniendo centrales...")
	enginesMu.Lock()
	for _, eng := range engines {
		eng.Stop()
	}
	enginesMu.Unlock()
	wg.Wait()
	log.Println("todas las centrales detenidas. Fin.")
}

func createEngine(username string, cfg *GlobalConfig, noPersist bool) *engine.Engine {
	persistPath := ""
	if !noPersist {
		persistPath = fmt.Sprintf("./%s/%s.json", sessionsDir, username)
	}

	strategyCfg := map[string]interface{}{
		"prices":          cfg.Prices,
		"market":          cfg.Market,
		"sim_time_factor": cfg.SimTimeFactor,
	}
	// Solo se pasan los overrides presentes: un 0 o un "" del YAML ausente
	// pisaría el default de la estrategia.
	if cfg.TipoInstalacion != "" {
		strategyCfg["tipo_instalacion"] = cfg.TipoInstalacion
	}
	if len(cfg.InsumosRenovables) > 0 {
		strategyCfg["insumos_renovables"] = cfg.InsumosRenovables
	}
	if cfg.MaxDesiredLevel > 0 {
		strategyCfg["max_desired_level"] = cfg.MaxDesiredLevel
	}
	if cfg.InventarioMaxExecs > 0 {
		strategyCfg["inventario_max_execs"] = cfg.InventarioMaxExecs
	}

	sdkCfg := &engine.Config{
		Server:  cfg.Server,
		Logging: cfg.Logging,
		Retry:   cfg.Retry,
		Bot: engine.BotConfig{
			Username: username,
			Password: cfg.Password,
			// Un único rol productivo (ADR-022): generar electricidad es una
			// transformación como cualquier otra.
			Role:                              models.RoleTransformer,
			PersistPath:                       persistPath,
			AutoRegister:                      true,
			TickIntervalSeconds:               cfg.TickIntervalSeconds,
			InsufficientCapitalBackoffSeconds: cfg.InsufficientCapitalBackoffSeconds,
			DepositRefreshSeconds:             cfg.DepositRefreshSeconds,
		},
		Strategy: strategyCfg,
	}
	return engine.NewEngine(sdkCfg, NewHidroStrategy(), nil, nil)
}

func loadConfig(path string) (*GlobalConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg GlobalConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}
