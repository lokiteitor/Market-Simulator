package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/lokiteitor/market-simulator/sdk/engine"
	"github.com/lokiteitor/market-simulator/sdk/logging"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
	"gopkg.in/yaml.v3"
)

type YAMLRequestedCapacity struct {
	RecipeID      string `yaml:"recipe_id"`
	Installations int    `yaml:"installations"`
}

type BotRunnerConfig struct {
	Username            string                  `yaml:"username"`
	Password            string                  `yaml:"password"`
	Role                models.AgentRole        `yaml:"role"`
	PersistPath         string                  `yaml:"persist_path"`
	AutoRegister        bool                    `yaml:"auto_register"`
	TickIntervalSeconds int                     `yaml:"tick_interval_seconds"`
	RequestedCapacities []YAMLRequestedCapacity `yaml:"requested_capacities"`
}

type GlobalConfig struct {
	Server  engine.ServerConfig    `yaml:"server"`
	Logging logging.Config         `yaml:"logging"`
	Retry   engine.RetryConfig     `yaml:"retry"`
	Prices  map[string]interface{} `yaml:"prices"`
	Bots    []BotRunnerConfig      `yaml:"bots"`
}

func main() {
	configPath := flag.String("config", "config.yaml", "path to config yaml file")
	flag.Parse()

	// Load config
	data, err := os.ReadFile(*configPath)
	if err != nil {
		log.Fatalf("Failed to read config file %s: %v", *configPath, err)
	}

	var globalCfg GlobalConfig
	if err := yaml.Unmarshal(data, &globalCfg); err != nil {
		log.Fatalf("Failed to parse config: %v", err)
	}

	log.Printf("Loaded global config with %d bot definitions", len(globalCfg.Bots))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup
	var engines []*engine.Engine

	// Start each bot
	for _, botCfg := range globalCfg.Bots {
		// Instantiate correct strategy
		var strat strategy.Strategy
		switch botCfg.Role {
		case "primary_producer":
			strat = NewPrimaryProducerStrategy()
		case "transformer":
			strat = NewTransformerStrategy()
		case "consumer":
			strat = NewConsumerStrategy()
		case "trader":
			strat = NewTraderStrategy()
		default:
			log.Printf("Warning: Unknown bot role '%s' for user '%s'. Skipping.", botCfg.Role, botCfg.Username)
			continue
		}

		// Map local capacities to models.RequestedCapacity
		reqCapacities := make([]models.RequestedCapacity, len(botCfg.RequestedCapacities))
		for i, capVal := range botCfg.RequestedCapacities {
			reqCapacities[i] = models.RequestedCapacity{
				RecipeID:      capVal.RecipeID,
				Installations: capVal.Installations,
			}
		}

		// Assemble SDK engine config
		sdkCfg := &engine.Config{
			Server: globalCfg.Server,
			Bot: engine.BotConfig{
				Username:            botCfg.Username,
				Password:            botCfg.Password,
				Role:                botCfg.Role,
				PersistPath:         botCfg.PersistPath,
				AutoRegister:        botCfg.AutoRegister,
				TickIntervalSeconds: botCfg.TickIntervalSeconds,
				RequestedCapacities: reqCapacities,
			},
			Logging: globalCfg.Logging,
			Retry:   globalCfg.Retry,
			Strategy: map[string]interface{}{
				"prices": globalCfg.Prices,
			},
		}

		// Create engine
		eng := engine.NewEngine(sdkCfg, strat, nil, nil)
		engines = append(engines, eng)

		// Start engine in background
		wg.Add(1)
		go func(e *engine.Engine, username string) {
			defer wg.Done()
			log.Printf("Starting engine for bot: %s...", username)
			if err := e.Start(ctx); err != nil {
				log.Printf("Engine for bot '%s' failed to start: %v", username, err)
			}
		}(eng, botCfg.Username)
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

	// Cancel context to stop starting any new loops, and stop running engines
	cancel()
	for _, eng := range engines {
		eng.Stop()
	}

	// Wait for goroutines to finish
	wg.Wait()
	log.Println("All bots stopped successfully. Exit.")
}
