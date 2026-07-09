package botengine

import (
	"github.com/lokiteitor/market-simulator/sdk/events"
)

// Behavior defines the lifecycle and decision making of a bot.
type Behavior interface {
	Init(ctx *Context) error
	Tick(ctx *Context) error
	OnEvent(ctx *Context, event events.Event) error
	Shutdown(ctx *Context) error
}
