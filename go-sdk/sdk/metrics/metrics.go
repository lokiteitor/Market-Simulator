package metrics

type Counter interface {
	Inc()
	Add(value int64)
}

type Gauge interface {
	Set(value float64)
}

type Histogram interface {
	Observe(value float64)
}

type Provider interface {
	NewCounter(name string, labels map[string]string) Counter
	NewGauge(name string, labels map[string]string) Gauge
	NewHistogram(name string, labels map[string]string) Histogram
}

// No-Op implementations to prevent nil-pointer panics

type NoOpCounter struct{}

func (NoOpCounter) Inc()           {}
func (NoOpCounter) Add(value int64) {}

type NoOpGauge struct{}

func (NoOpGauge) Set(value float64) {}

type NoOpHistogram struct{}

func (NoOpHistogram) Observe(value float64) {}

type NoOpProvider struct{}

func (NoOpProvider) NewCounter(name string, labels map[string]string) Counter {
	return NoOpCounter{}
}

func (NoOpProvider) NewGauge(name string, labels map[string]string) Gauge {
	return NoOpGauge{}
}

func (NoOpProvider) NewHistogram(name string, labels map[string]string) Histogram {
	return NoOpHistogram{}
}
