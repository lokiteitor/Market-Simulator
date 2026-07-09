package scheduler

import (
	"context"
	"sync"
	"time"
)

type Job func(ctx context.Context)

type Scheduler struct {
	sync.Mutex
	wg     sync.WaitGroup
	ctx    context.Context
	cancel context.CancelFunc
}

func NewScheduler() *Scheduler {
	return &Scheduler{}
}

// Start initializes the scheduler with a parent context.
func (s *Scheduler) Start(ctx context.Context) {
	s.Lock()
	defer s.Unlock()
	s.ctx, s.cancel = context.WithCancel(ctx)
}

// Stop cancels all scheduled jobs and waits for them to complete.
func (s *Scheduler) Stop() {
	s.Lock()
	if s.cancel != nil {
		s.cancel()
	}
	s.Unlock()
	s.wg.Wait()
}

// SchedulePeriodic schedules a job to run periodically at the specified interval.
func (s *Scheduler) SchedulePeriodic(interval time.Duration, job Job) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				// Double check context before running
				select {
				case <-s.ctx.Done():
					return
				default:
					job(s.ctx)
				}
			case <-s.ctx.Done():
				return
			}
		}
	}()
}

// ScheduleDelayed schedules a job to run once after the specified delay duration.
func (s *Scheduler) ScheduleDelayed(delay time.Duration, job Job) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		timer := time.NewTimer(delay)
		defer timer.Stop()

		select {
		case <-timer.C:
			// Double check context before running
			select {
			case <-s.ctx.Done():
				return
			default:
				job(s.ctx)
			}
		case <-s.ctx.Done():
			return
		}
	}()
}
