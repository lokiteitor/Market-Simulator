package botengine

import (
	"context"
)

// Bot wraps the Behavior and its Context.
// It manages the execution lifecycle of the behavior.
type Bot struct {
	Behavior   Behavior
	Context    *Context
	Scheduler  *Scheduler
	Dispatcher *EventDispatcher
}

func NewBot(b Behavior, ctx *Context, sched *Scheduler) *Bot {
	return &Bot{
		Behavior:   b,
		Context:    ctx,
		Scheduler:  sched,
		Dispatcher: NewEventDispatcher(b, ctx),
	}
}

func (b *Bot) Run(ctx context.Context) error {
	if err := b.Behavior.Init(b.Context); err != nil {
		return err
	}

	// Schedule ticks in a goroutine
	go b.Scheduler.Run(ctx, b.Behavior, b.Context)

	// Wait for context cancellation
	<-ctx.Done()

	return b.Behavior.Shutdown(b.Context)
}
