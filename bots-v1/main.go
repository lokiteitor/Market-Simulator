package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

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
	scale := flag.Int("scale", 0, "number of bots to run programmatically (ignores YAML bot list if > 0)")
	jitterSec := flag.Int("jitter", 0, "max startup jitter in seconds to spread connection load (default: 0)")
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

	// Prepare list of bot configurations
	var botsToRun []BotRunnerConfig

	if *scale > 0 {
		log.Printf("Scale mode active. Generating %d bots programmatically...", *scale)
		roles := []models.AgentRole{"primary_producer", "transformer", "consumer", "trader"}
		
		// Setup sub-recipes to distribute amongst producers & transformers
		producerRecipes := []string{"cultivo_trigo", "cultivo_maiz", "ordena", "cultivo_tomate", "germinado_rapido"}
		transformerRecipeSets := [][]string{
			{"molienda", "panaderia"},
			{"nixtamalizado", "tortilleria"},
			{"queseria"},
			{"salseria"},
		}

		for i := 1; i <= *scale; i++ {
			// Round-robin distribution of roles
			role := roles[(i-1)%len(roles)]
			username := fmt.Sprintf("scale_%s_%d", role, i)
			
			bot := BotRunnerConfig{
				Username:            username,
				Password:            "dev-password-123", // standard dev password
				Role:                role,
				PersistPath:         fmt.Sprintf("./sessions/%s.json", username),
				AutoRegister:        true,
				TickIntervalSeconds: 5,
			}

			// Distribute capacities
			if role == "primary_producer" {
				recipeIndex := (i - 1) % len(producerRecipes)
				recipeID := producerRecipes[recipeIndex]
				bot.RequestedCapacities = []YAMLRequestedCapacity{
					{RecipeID: recipeID, Installations: 2},
				}
			} else if role == "transformer" {
				setIndex := (i - 1) % len(transformerRecipeSets)
				recipes := transformerRecipeSets[setIndex]
				bot.RequestedCapacities = make([]YAMLRequestedCapacity, len(recipes))
				for rIdx, recipeID := range recipes {
					bot.RequestedCapacities[rIdx] = YAMLRequestedCapacity{
						RecipeID:      recipeID,
						Installations: 2,
					}
				}
			}

			botsToRun = append(botsToRun, bot)
		}
	} else {
		botsToRun = globalCfg.Bots
	}

	log.Printf("Starting simulation with %d concurrent bots...", len(botsToRun))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup
	var engines []*engine.Engine
	var enginesMu sync.Mutex

	// Seed random for startup jitter
	r := rand.New(rand.NewSource(time.Now().UnixNano()))

	// Create and start each bot
	for idx, botCfg := range botsToRun {
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

		reqCapacities := make([]models.RequestedCapacity, len(botCfg.RequestedCapacities))
		for i, capVal := range botCfg.RequestedCapacities {
			reqCapacities[i] = models.RequestedCapacity{
				RecipeID:      capVal.RecipeID,
				Installations: capVal.Installations,
			}
		}

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

		eng := engine.NewEngine(sdkCfg, strat, nil, nil)
		
		enginesMu.Lock()
		engines = append(engines, eng)
		enginesMu.Unlock()

		wg.Add(1)
		go func(e *engine.Engine, username string, botIdx int) {
			defer wg.Done()

			// Apply startup jitter if configured
			if *jitterSec > 0 {
				delay := time.Duration(r.Intn(*jitterSec*1000)) * time.Millisecond
				log.Printf("[%s] Delaying start by %v to spread load...", username, delay)
				select {
				case <-time.After(delay):
				case <-ctx.Done():
					return
				}
			}

			log.Printf("[%s] Launching bot (%d/%d)...", username, botIdx+1, len(botsToRun))
			if err := e.Start(ctx); err != nil {
				log.Printf("[%s] Bot failed to start: %v", username, err)
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
