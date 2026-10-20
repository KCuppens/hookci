package scheduler

import "time"

// Clock is injected so tests never sleep.
type Clock interface {
	Now() time.Time
}

// RealClock reads the wall clock.
type RealClock struct{}

// Now returns time.Now().
func (RealClock) Now() time.Time { return time.Now() }
