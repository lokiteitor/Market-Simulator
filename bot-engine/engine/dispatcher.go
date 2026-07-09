package botengine

import (
	"github.com/lokiteitor/market-simulator/sdk/events"
)

// EventDispatcher routes domain events to the behavior.
type EventDispatcher struct {
	behavior Behavior
	botCtx   *Context
}

func NewEventDispatcher(b Behavior, ctx *Context) *EventDispatcher {
	return &EventDispatcher{
		behavior: b,
		botCtx:   ctx,
	}
}

func (d *EventDispatcher) Dispatch(event events.Event) error {
	return d.behavior.OnEvent(d.botCtx, event)
}
