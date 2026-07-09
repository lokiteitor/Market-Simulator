package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/lokiteitor/market-simulator/sdk/actions"
	"github.com/lokiteitor/market-simulator/sdk/engine"
	"github.com/lokiteitor/market-simulator/sdk/events"
	"github.com/lokiteitor/market-simulator/sdk/strategy"
)

type NoOpStrategy struct{}

func (s *NoOpStrategy) Initialize(ctx *strategy.Context) error {
	ctx.Logger.Info("NoOpStrategy initialized!")
	return nil
}

func (s *NoOpStrategy) Tick(ctx *strategy.Context) []actions.Action {
	avail, reserved := ctx.State.Capital()
	ctx.Logger.Info("Strategy tick triggered", "capital_available_cents", avail, "capital_reserved_cents", reserved)
	return nil
}

func (s *NoOpStrategy) HandleEvent(ctx *strategy.Context, ev events.Event) []actions.Action {
	ctx.Logger.Info("Strategy received event", "type", fmt.Sprintf("%T", ev))
	return nil
}

func main() {
	configPath := flag.String("config", "config.example.yaml", "path to config yaml file")
	flag.Parse()

	cfg, err := engine.LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	strat := &NoOpStrategy{}
	eng := engine.NewEngine(cfg, strat, nil, nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Wait for OS signals to stop cleanly
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		log.Println("Shutdown signal received, stopping agent...")
		cancel()
		eng.Stop()
	}()

	if err := eng.Start(ctx); err != nil {
		log.Fatalf("Engine failed to start: %v", err)
	}

	// Wait until context is cancelled (via signal)
	<-ctx.Done()
	log.Println("Agent stopped.")
}
