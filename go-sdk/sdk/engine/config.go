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
	Username            string                     `yaml:"username"`
	Password            string                     `yaml:"password"`
	Role                models.AgentRole           `yaml:"role"`
	PersistPath         string                     `yaml:"persist_path"`
	AutoRegister        bool                       `yaml:"auto_register"`
	TickIntervalSeconds int                        `yaml:"tick_interval_seconds"`
	RequestedCapacities []models.RequestedCapacity `yaml:"requested_capacities"`
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
