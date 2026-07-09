package botengine

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand"
	"os"
	"time"

	"github.com/lokiteitor/market-simulator/sdk/client"
	"gopkg.in/yaml.v3"
)

type Config struct {
	Simulation struct {
		Duration string `yaml:"duration"`
	} `yaml:"simulation"`
	Bots map[string]map[string]interface{} `yaml:"bots"`
}

type Runner struct {
	Factory *BotFactory
}

func NewRunner(factory *BotFactory) *Runner {
	return &Runner{
		Factory: factory,
	}
}

func (r *Runner) RunFromConfig(ctx context.Context, configPath string) error {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("failed to read config: %w", err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return fmt.Errorf("failed to unmarshal config: %w", err)
	}

	var duration time.Duration
	if cfg.Simulation.Duration != "" {
		d, err := time.ParseDuration(cfg.Simulation.Duration)
		if err != nil {
			return fmt.Errorf("invalid simulation duration: %w", err)
		}
		duration = d
	} else {
		duration = 24 * time.Hour // default duration
	}

	simCtx, cancel := context.WithTimeout(ctx, duration)
	defer cancel()

	// Parse bots and run them
	for botType, botConfigs := range cfg.Bots {
		behavior, err := r.Factory.Create(botType, botConfigs)
		if err != nil {
			return fmt.Errorf("failed to create bot %s: %w", botType, err)
		}

		// Initialize bot context dependencies
		// In a real scenario, baseURL and credentials should also be in the config
		sdkClient := client.NewClient("http://localhost:8080", nil, nil)
		botCtx := &Context{
			SDK:     sdkClient,
			State:   NewState(),
			Metrics: NewMetrics(),
			Random:  rand.New(rand.NewSource(time.Now().UnixNano())),
			Logger:  slog.Default(),
		}

		scheduler := NewScheduler(1 * time.Second) // This could also come from config
		bot := NewBot(behavior, botCtx, scheduler)

		go func(bType string) {
			slog.Info("Starting bot", "type", bType)
			if err := bot.Run(simCtx); err != nil {
				slog.Error("Bot exited with error", "type", bType, "error", err)
			}
		}(botType)
	}

	slog.Info("All bots started, waiting for simulation to finish...")
	<-simCtx.Done()
	slog.Info("Simulation finished")
	return nil
}
