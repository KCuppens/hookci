package hubclient

import (
	"math/rand/v2"
	"time"
)

// Backoff bounds and the connected time after which it starts over.
const (
	backoffFloor = time.Second
	backoffCap   = 30 * time.Second
	// ResetAfter is how long a session must stay connected for the next
	// reconnect to start again from Min.
	ResetAfter = 60 * time.Second
)

// Backoff computes reconnect delays with full jitter: attempt n waits a random
// duration in [0, min(Max, Min*2^n)), then clamped to [1 s, 30 s]. The zero
// value uses Min 1 s and Max 30 s.
type Backoff struct {
	Min, Max time.Duration
	// Rand returns a float in [0, 1); nil uses math/rand/v2.
	Rand func() float64

	attempt int
}

// Next returns the delay before the next reconnect attempt and advances the
// attempt count.
func (b *Backoff) Next() time.Duration {
	lo, hi := b.Min, b.Max
	if lo <= 0 {
		lo = backoffFloor
	}
	if hi <= 0 || hi > backoffCap {
		hi = backoffCap
	}
	ceil := lo
	for i := 0; i < b.attempt && ceil < hi; i++ {
		ceil *= 2
	}
	ceil = min(ceil, hi)
	if ceil < hi {
		b.attempt++
	}
	r := rand.Float64
	if b.Rand != nil {
		r = b.Rand
	}
	d := time.Duration(r() * float64(ceil))
	return min(max(d, backoffFloor), backoffCap)
}

// Disconnected records that a session ended after staying connected for d. A
// session of at least ResetAfter resets the attempt count.
func (b *Backoff) Disconnected(d time.Duration) {
	if d >= ResetAfter {
		b.attempt = 0
	}
}
