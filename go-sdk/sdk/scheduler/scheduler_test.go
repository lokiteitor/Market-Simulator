package scheduler

import (
	"context"
	"testing"
	"time"
)

// El primer disparo debe ser inmediato: un bot rotativo puede vivir menos que
// el intervalo (deposit_refresh_seconds > active_duration) y aun así el job
// tiene que correr al menos una vez.
func TestSchedulePeriodicDisparaInmediatamente(t *testing.T) {
	s := NewScheduler()
	s.Start(context.Background())
	defer s.Stop()

	fired := make(chan struct{})
	s.SchedulePeriodic(time.Hour, func(ctx context.Context) {
		close(fired)
	})

	select {
	case <-fired:
	case <-time.After(time.Second):
		t.Fatal("el job no disparó inmediatamente al programarse")
	}
}

func TestSchedulePeriodicNoDisparaTrasStop(t *testing.T) {
	s := NewScheduler()
	s.Start(context.Background())
	s.Stop()

	fired := make(chan struct{}, 1)
	s.SchedulePeriodic(10*time.Millisecond, func(ctx context.Context) {
		fired <- struct{}{}
	})

	select {
	case <-fired:
		t.Fatal("el job disparó con el scheduler ya parado")
	case <-time.After(100 * time.Millisecond):
	}
}
