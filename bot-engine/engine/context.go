package botengine

import (
	"log/slog"
	"math/rand"

	"github.com/lokiteitor/market-simulator/sdk/client"
)

// Context is provided to Behaviors so they can read state, metrics, log, and interact with the SDK.
type Context struct {
	SDK     *client.Client
	State   *State
	Metrics *Metrics
	Random  *rand.Rand
	Logger  *slog.Logger
}
