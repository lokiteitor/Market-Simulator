// bots-ciudad lanza el conjunto FIJO de ciudades-consumidor (capitales del
// mundo) que modelan la demanda urbana permanente del mercado. A diferencia de
// bots-v1 (replicable en varias instancias vía usernames derivados de
// --runner-id), aquí los usernames son literales y compartidos, así que el
// binario es de INSTANCIA ÚNICA: un flock impide que dos procesos logueen las
// mismas cuentas y se roten mutuamente el refresh token (de un solo uso).
//
// Las cuentas las siembra el backend (rol `city`, no registrable por humanos);
// este binario solo hace LOGIN (auto_register=false) con las credenciales de
// infra/cities.json + city_password.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/lokiteitor/market-simulator/sdk/botkit"
	"github.com/lokiteitor/market-simulator/sdk/engine"
	"github.com/lokiteitor/market-simulator/sdk/logging"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"gopkg.in/yaml.v3"
)

// GlobalConfig refleja bots-ciudad/config.yaml. Reutiliza los tipos del SDK
// (mismos yaml tags que bots-v1) para server/logging/retry.
type GlobalConfig struct {
	Server                            engine.ServerConfig    `yaml:"server"`
	Logging                           logging.Config         `yaml:"logging"`
	Retry                             engine.RetryConfig     `yaml:"retry"`
	SimTimeFactor                     float64                `yaml:"sim_time_factor"`
	InsufficientCapitalBackoffSeconds int                    `yaml:"insufficient_capital_backoff_seconds"`
	Market                            map[string]interface{} `yaml:"market"`
	Prices                            map[string]interface{} `yaml:"prices"`
	CitiesPath                        string                 `yaml:"cities_path"`
	CityPassword                      string                 `yaml:"city_password"`
	TickIntervalSeconds               int                    `yaml:"tick_interval_seconds"`
	StartupJitterSeconds              int                    `yaml:"startup_jitter_seconds"`
}

// City es una entrada de infra/cities.json (fuente única compartida con el
// seed del backend). bots-ciudad solo necesita el username; population_weight
// lo consume el backend.
type City struct {
	Username         string `json:"username"`
	Display          string `json:"display"`
	PopulationWeight int64  `json:"population_weight"`
}

type citiesFile struct {
	Cities []City `json:"cities"`
}

// sessionsDir guarda la sesión (SQLite) de cada ciudad. Se conserva entre
// reinicios para reutilizar la cadena de refresh tokens de las cuentas fijas.
const sessionsDir = "sessions"

func main() {
	configPath := flag.String("config", "config.yaml", "ruta al config yaml")
	citiesFlag := flag.String("cities", "", "ruta a cities.json (default: cities_path del config)")
	lockPath := flag.String("lock", ".bots-ciudad.lock", "lockfile de instancia única")
	flag.Parse()

	// Instancia única: sin esto, dos procesos loguearían las mismas 50 cuentas
	// y rotarían mutuamente el refresh token (de un solo uso) → thrashing de
	// auth. Los usernames son literales, no se pueden shardear entre procesos.
	lockFile, err := acquireSingletonLock(*lockPath)
	if err != nil {
		log.Fatalf("bots-ciudad ya está corriendo (no se pudo tomar el lock %s): %v", *lockPath, err)
	}
	defer releaseSingletonLock(lockFile, *lockPath)

	cfg, err := loadConfig(*configPath)
	if err != nil {
		log.Fatalf("no se pudo cargar el config %s: %v", *configPath, err)
	}
	if cfg.SimTimeFactor <= 0 {
		cfg.SimTimeFactor = 5
	}
	if cfg.TickIntervalSeconds <= 0 {
		cfg.TickIntervalSeconds = 5
	}
	if cfg.CityPassword == "" {
		log.Fatal("city_password vacío en el config: debe coincidir con el que sembró el backend")
	}

	// El directorio de sesiones no se versiona (gitignore), así que en un clone
	// limpio no existe: sin él, el SQLite de sesión del SDK no se puede abrir.
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		log.Fatalf("no se pudo crear el directorio de sesiones %s: %v", sessionsDir, err)
	}

	citiesPath := cfg.CitiesPath
	if *citiesFlag != "" {
		citiesPath = *citiesFlag
	}
	cities, err := loadCities(citiesPath)
	if err != nil {
		log.Fatalf("no se pudo cargar la lista de ciudades %s: %v", citiesPath, err)
	}
	if len(cities) == 0 {
		log.Fatal("la lista de ciudades está vacía")
	}
	log.Printf("bots-ciudad: %d ciudades cargadas de %s", len(cities), citiesPath)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	r := rand.New(rand.NewSource(time.Now().UnixNano()))

	var wg sync.WaitGroup
	var enginesMu sync.Mutex
	engines := make([]*engine.Engine, 0, len(cities))

	for _, city := range cities {
		eng := createCityEngine(city, cfg)
		enginesMu.Lock()
		engines = append(engines, eng)
		enginesMu.Unlock()

		wg.Add(1)
		go func(e *engine.Engine, username string) {
			defer wg.Done()
			if cfg.StartupJitterSeconds > 0 {
				delay := time.Duration(r.Intn(cfg.StartupJitterSeconds*1000)) * time.Millisecond
				select {
				case <-time.After(delay):
				case <-ctx.Done():
					return
				}
			}
			log.Printf("[%s] arrancando ciudad...", username)
			if err := e.Start(ctx); err != nil {
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					return
				}
				// Login fallido: la cuenta debe existir (sembrada por el backend)
				// y la contraseña coincidir.
				log.Printf("[%s] no arrancó: %v", username, err)
			}
		}(eng, city.Username)
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-sigChan:
		log.Printf("señal %v recibida, apagando...", sig)
	case <-ctx.Done():
	}

	cancel()
	log.Println("deteniendo ciudades...")
	enginesMu.Lock()
	for _, eng := range engines {
		eng.Stop()
	}
	enginesMu.Unlock()
	wg.Wait()
	log.Println("todas las ciudades detenidas. Fin.")
}

func createCityEngine(city City, cfg *GlobalConfig) *engine.Engine {
	sdkCfg := &engine.Config{
		Server:  cfg.Server,
		Logging: cfg.Logging,
		Retry:   cfg.Retry,
		Bot: engine.BotConfig{
			Username:                          city.Username,
			Password:                          cfg.CityPassword,
			Role:                              models.RoleCity,
			PersistPath:                       filepath.Join(sessionsDir, city.Username+".json"),
			AutoRegister:                      false, // login-only: la cuenta ya existe sembrada
			TickIntervalSeconds:               cfg.TickIntervalSeconds,
			InsufficientCapitalBackoffSeconds: cfg.InsufficientCapitalBackoffSeconds,
		},
		Strategy: map[string]interface{}{
			"prices":          cfg.Prices,
			"market":          cfg.Market,
			"sim_time_factor": cfg.SimTimeFactor,
		},
	}
	return engine.NewEngine(sdkCfg, botkit.NewConsumerStrategy(), nil, nil)
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

func loadCities(path string) ([]City, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f citiesFile
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, err
	}
	return f.Cities, nil
}

// acquireSingletonLock toma un flock exclusivo no-bloqueante sobre lockPath.
// Devuelve error si otra instancia ya lo tiene.
func acquireSingletonLock(lockPath string) (*os.File, error) {
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, err
	}
	if _, err := fmt.Fprintf(f, "pid=%d\n", os.Getpid()); err != nil {
		// No es fatal: el lock ya está tomado; solo es informativo.
		log.Printf("aviso: no se pudo escribir el pid en el lockfile: %v", err)
	}
	return f, nil
}

func releaseSingletonLock(f *os.File, lockPath string) {
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	_ = f.Close()
	_ = os.Remove(lockPath)
}
