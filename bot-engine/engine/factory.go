package botengine

import (
	"fmt"
)

// BehaviorBuilder is a function that creates a new Behavior based on a configuration map.
type BehaviorBuilder func(cfg map[string]interface{}) (Behavior, error)

// BotFactory creates Behaviors based on their string type.
type BotFactory struct {
	builders map[string]BehaviorBuilder
}

func NewBotFactory() *BotFactory {
	return &BotFactory{
		builders: make(map[string]BehaviorBuilder),
	}
}

func (f *BotFactory) Register(name string, builder BehaviorBuilder) {
	f.builders[name] = builder
}

func (f *BotFactory) Create(name string, cfg map[string]interface{}) (Behavior, error) {
	builder, ok := f.builders[name]
	if !ok {
		return nil, fmt.Errorf("no builder registered for behavior: %s", name)
	}
	return builder(cfg)
}
