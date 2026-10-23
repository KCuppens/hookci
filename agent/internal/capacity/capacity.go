// Package capacity admits check work against a CPU and memory budget and
// against the host's free memory and load, so runs going side by side stay
// within what the machine can spare next to whatever else it hosts.
//
// Work is admitted when nothing else holds the pool, so one setup or job at
// a time always makes progress. Past that, a demand must fit the budget's
// remainder and the host must have room for it right now.
package capacity

import (
	"context"
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"time"

	"github.com/KCuppens/hookci/agent/internal/clock"
)

// DefaultMemReserve is the memory the host keeps free past every admitted
// demand.
const DefaultMemReserve int64 = 4 << 30

// RecheckInterval is how often refused work is woken to try again, since
// the host's free memory and load change without a Release.
const RecheckInterval = 5 * time.Second

// Demand is what one setup or job asks for: its CPU and memory limits.
type Demand struct {
	CPUs        float64
	MemoryBytes int64
}

// Sample is the host's state at one instant.
type Sample struct {
	MemAvailable int64   // bytes, as /proc/meminfo's MemAvailable
	Load1        float64 // one-minute load average
}

// Host reads the machine's current free memory and load.
type Host interface {
	Sample() (Sample, error)
}

// Options configure a Pool.
type Options struct {
	CPUs        float64      // budget in cores; <= 0 means none
	MemoryBytes int64        // budget in bytes; <= 0 means none
	Host        Host         // nil skips the live check
	CPUCount    int          // load ceiling; <= 0 means runtime.NumCPU()
	MemReserve  int64        // < 0 means none; 0 means DefaultMemReserve
	Clock       clock.Clock  // nil means clock.Real
	Logger      *slog.Logger // nil discards
}

// Pool is the budget shared by every run of an agent.
type Pool struct {
	o       Options
	mu      sync.Mutex
	used    Demand
	held    int    // admitted demands not yet released
	refused bool   // a TryAcquire failed since the last recheck
	busy    string // the last live refusal, logged once per change
	failing bool   // the last host sample failed
	subs    map[uint64]func()
	nextSub uint64
}

// New returns a Pool with o's budget.
func New(o Options) *Pool {
	if o.CPUCount <= 0 {
		o.CPUCount = runtime.NumCPU()
	}
	switch {
	case o.MemReserve == 0:
		o.MemReserve = DefaultMemReserve
	case o.MemReserve < 0:
		o.MemReserve = 0
	}
	if o.Clock == nil {
		o.Clock = clock.Real{}
	}
	if o.Logger == nil {
		o.Logger = slog.New(slog.DiscardHandler)
	}
	return &Pool{o: o, subs: map[uint64]func(){}}
}

// TryAcquire admits d when it fits, and reports whether it did. An admitted
// demand holds its share until Release.
func (p *Pool) TryAcquire(d Demand) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.held > 0 && (!p.fitsBudget(d) || !p.hostHasRoom(d)) {
		p.refused = true
		return false
	}
	p.used.CPUs += d.CPUs
	p.used.MemoryBytes += d.MemoryBytes
	p.held++
	return true
}

// Release returns d, admitted by TryAcquire, and wakes every subscriber.
func (p *Pool) Release(d Demand) {
	p.mu.Lock()
	p.used.CPUs -= d.CPUs
	p.used.MemoryBytes -= d.MemoryBytes
	p.held--
	wake := p.subscribers()
	p.mu.Unlock()
	for _, fn := range wake {
		fn()
	}
}

// Subscribe calls wake whenever refused work may now fit: on every Release
// and on rechecks. wake must not block. The returned func unsubscribes.
func (p *Pool) Subscribe(wake func()) func() {
	p.mu.Lock()
	defer p.mu.Unlock()
	id := p.nextSub
	p.nextSub++
	p.subs[id] = wake
	return func() {
		p.mu.Lock()
		delete(p.subs, id)
		p.mu.Unlock()
	}
}

// Run wakes the subscribers every RecheckInterval after a refusal, until
// ctx ends.
func (p *Pool) Run(ctx context.Context) {
	t := p.o.Clock.NewTicker(RecheckInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C():
		}
		p.mu.Lock()
		var wake []func()
		if p.refused {
			p.refused = false
			wake = p.subscribers()
		}
		p.mu.Unlock()
		for _, fn := range wake {
			fn()
		}
	}
}

// subscribers returns the wake funcs. p.mu must be held.
func (p *Pool) subscribers() []func() {
	out := make([]func(), 0, len(p.subs))
	for _, fn := range p.subs {
		out = append(out, fn)
	}
	return out
}

// fitsBudget reports whether d fits the rest of the budget. p.mu must be
// held.
func (p *Pool) fitsBudget(d Demand) bool {
	if p.o.CPUs > 0 && p.used.CPUs+d.CPUs > p.o.CPUs {
		return false
	}
	if p.o.MemoryBytes > 0 && p.used.MemoryBytes+d.MemoryBytes > p.o.MemoryBytes {
		return false
	}
	return true
}

// hostHasRoom reports whether the host can take d now: d's memory plus the
// reserve is available and the load is below the CPU count. A failed sample
// does not refuse. p.mu must be held.
func (p *Pool) hostHasRoom(d Demand) bool {
	if p.o.Host == nil {
		return true
	}
	s, err := p.o.Host.Sample()
	if err != nil {
		if !p.failing {
			p.failing = true
			p.o.Logger.Warn("host sample failed; admitting by budget only", "err", err)
		}
		return true
	}
	p.failing = false
	busy := ""
	switch {
	case s.MemAvailable-d.MemoryBytes < p.o.MemReserve:
		busy = fmt.Sprintf("%d MiB available, work needs %d MiB plus %d MiB reserve",
			s.MemAvailable>>20, d.MemoryBytes>>20, p.o.MemReserve>>20)
	case s.Load1 >= float64(p.o.CPUCount):
		busy = fmt.Sprintf("load %.2f on %d CPUs", s.Load1, p.o.CPUCount)
	}
	p.note(busy)
	return busy == ""
}

// note logs busy when it differs from the last one. p.mu must be held.
func (p *Pool) note(busy string) {
	if busy == p.busy {
		return
	}
	p.busy = busy
	if busy != "" {
		p.o.Logger.Info("host busy; holding new work", "why", busy)
	}
}
