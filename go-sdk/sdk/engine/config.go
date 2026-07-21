package engine

import (
	"os"

	"github.com/lokiteitor/market-simulator/sdk/logging"
	"github.com/lokiteitor/market-simulator/sdk/models"
	"gopkg.in/yaml.v3"
)

type ServerConfig struct {
	BaseURL string `yaml:"base_url"`
	WSURL   string `yaml:"ws_url"`
}

type BotConfig struct {
	Username            string           `yaml:"username"`
	Password            string           `yaml:"password"`
	Role                models.AgentRole `yaml:"role"`
	PersistPath         string           `yaml:"persist_path"`
	AutoRegister        bool             `yaml:"auto_register"`
	TickIntervalSeconds int              `yaml:"tick_interval_seconds"`
	// InsufficientCapitalBackoffSeconds: cuánto duerme el bot (segundos
	// reales) tras recibir un 422 insufficient_capital del servidor, para
	// dejar de martillar la API mientras se recupera capital (crítico en modo
	// swarm). 0 usa el default del engine (60s).
	InsufficientCapitalBackoffSeconds int `yaml:"insufficient_capital_backoff_seconds"`
	// DepositRefreshSeconds: cada cuánto se relee GET /catalog/deposits
	// (ADR-023). El rendimiento de un yacimiento se mueve en horas, así que el
	// default (300 s) sobra; lo que NO se puede es no refrescarlo nunca, o el
	// bot seguiría valorando la receta con el output nominal. 0 usa el default.
	DepositRefreshSeconds int `yaml:"deposit_refresh_seconds"`
}

type RetryConfig struct {
	MaxAttempts      int `yaml:"max_attempts"`
	InitialBackoffMs int `yaml:"initial_backoff_ms"`
	MaxBackoffMs     int `yaml:"max_backoff_ms"`
}

type Config struct {
	Server   ServerConfig           `yaml:"server"`
	Bot      BotConfig              `yaml:"bot"`
	Logging  logging.Config         `yaml:"logging"`
	Retry    RetryConfig            `yaml:"retry"`
	Strategy map[string]interface{} `yaml:"strategy"`
}

func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}
