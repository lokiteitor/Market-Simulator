package botengine

import "sync"

// Metrics collects behavior metrics.
type Metrics struct {
	mu       sync.Mutex
	counters map[string]int64
}

func NewMetrics() *Metrics {
	return &Metrics{
		counters: make(map[string]int64),
	}
}

func (m *Metrics) Increment(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.counters[key]++
}

func (m *Metrics) Get(key string) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.counters[key]
}
