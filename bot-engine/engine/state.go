package botengine

import "sync"

// State holds the local synchronized state of the bot.
// The SDK will update this state (e.g. via Snapshot Sync), and Behaviors will read from it.
type State struct {
	mu sync.RWMutex

	Capital   int64
	Inventory map[string]int64
	Orders    map[string]interface{}
	Processes map[string]interface{}
	TopBook   map[string]interface{}
	Trades    []interface{}
	Products  map[string]interface{}
	Recipes   map[string]interface{}
}

func NewState() *State {
	return &State{
		Inventory: make(map[string]int64),
		Orders:    make(map[string]interface{}),
		Processes: make(map[string]interface{}),
		TopBook:   make(map[string]interface{}),
		Trades:    make([]interface{}, 0),
		Products:  make(map[string]interface{}),
		Recipes:   make(map[string]interface{}),
	}
}
