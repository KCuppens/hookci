// Package clock abstracts time so code with timeouts and tickers can be tested
// without sleeping.
package clock

import (
	"sync"
	"time"
)

// Clock is the time source for timers and tickers.
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
	NewTicker(d time.Duration) Ticker
}

// Ticker delivers ticks on C until stopped.
type Ticker interface {
	C() <-chan time.Time
	Stop()
}

// Real is the wall clock.
type Real struct{}

// Now returns time.Now.
func (Real) Now() time.Time { return time.Now() }

// After returns time.After(d).
func (Real) After(d time.Duration) <-chan time.Time { return time.After(d) }

// NewTicker returns a ticker backed by time.NewTicker.
func (Real) NewTicker(d time.Duration) Ticker { return realTicker{time.NewTicker(d)} }

type realTicker struct{ t *time.Ticker }

func (r realTicker) C() <-chan time.Time { return r.t.C }
func (r realTicker) Stop()               { r.t.Stop() }

// Fake is a manually advanced clock. Timers and tickers fire only from
// Advance. It is safe for concurrent use.
type Fake struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

type fakeTimer struct {
	at     time.Time
	period time.Duration // zero for one-shot timers
	ch     chan time.Time
	fake   *Fake
}

// NewFake returns a fake clock set to start.
func NewFake(start time.Time) *Fake { return &Fake{now: start} }

// Now returns the fake time.
func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

// After returns a channel that receives the fake time once the clock has been
// advanced by at least d.
func (f *Fake) After(d time.Duration) <-chan time.Time {
	return f.add(d, 0).ch
}

// NewTicker returns a ticker that ticks every d of fake time. Like
// time.Ticker it drops ticks a slow receiver misses.
func (f *Fake) NewTicker(d time.Duration) Ticker {
	if d <= 0 {
		panic("clock: non-positive ticker interval")
	}
	return f.add(d, d)
}

func (f *Fake) add(d, period time.Duration) *fakeTimer {
	f.mu.Lock()
	defer f.mu.Unlock()
	t := &fakeTimer{at: f.now.Add(d), period: period, ch: make(chan time.Time, 1), fake: f}
	if d <= 0 && period == 0 {
		t.ch <- f.now
		return t
	}
	f.timers = append(f.timers, t)
	return t
}

// Advance moves the clock forward by d and fires every timer and ticker due
// at or before the new time.
func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d)
	kept := f.timers[:0]
	for _, t := range f.timers {
		if t.at.After(f.now) {
			kept = append(kept, t)
			continue
		}
		select {
		case t.ch <- f.now:
		default:
		}
		if t.period > 0 {
			for !t.at.After(f.now) {
				t.at = t.at.Add(t.period)
			}
			kept = append(kept, t)
		}
	}
	clear(f.timers[len(kept):])
	f.timers = kept
}

func (t *fakeTimer) C() <-chan time.Time { return t.ch }

func (t *fakeTimer) Stop() {
	f := t.fake
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, x := range f.timers {
		if x == t {
			f.timers = append(f.timers[:i], f.timers[i+1:]...)
			return
		}
	}
}
