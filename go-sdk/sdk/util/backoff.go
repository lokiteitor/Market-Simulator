package util

import (
	"context"
	"math"
	"time"
)

type Backoff struct {
	Min    time.Duration
	Max    time.Duration
	Factor float64
}

func NewBackoff(min, max time.Duration, factor float64) *Backoff {
	if min <= 0 {
		min = 100 * time.Millisecond
	}
	if max <= 0 {
		max = 30 * time.Second
	}
	if factor <= 0 {
		factor = 2.0
	}
	return &Backoff{
		Min:    min,
		Max:    max,
		Factor: factor,
	}
}

func (b *Backoff) Sleep(ctx context.Context, attempt int) error {
	dur := b.Duration(attempt)
	select {
	case <-time.After(dur):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (b *Backoff) Duration(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	// Calculate backoff: min * (factor ^ attempt)
	val := float64(b.Min) * math.Pow(b.Factor, float64(attempt))
	dur := time.Duration(val)
	if dur > b.Max || dur < 0 { // overflow check
		dur = b.Max
	}
	return dur
}
