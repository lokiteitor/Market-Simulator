package botengine

import (
	"context"
	"time"
)

// Scheduler runs the Tick loop of a behavior at a specific frequency.
type Scheduler struct {
	Frequency time.Duration
}

func NewScheduler(freq time.Duration) *Scheduler {
	return &Scheduler{
		Frequency: freq,
	}
}

func (s *Scheduler) Run(ctx context.Context, behavior Behavior, botCtx *Context) {
	ticker := time.NewTicker(s.Frequency)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := behavior.Tick(botCtx); err != nil {
				if botCtx.Logger != nil {
					botCtx.Logger.Error("Tick failed", "error", err)
				}
			}
		}
	}
}
