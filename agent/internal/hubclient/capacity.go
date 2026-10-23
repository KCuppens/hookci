package hubclient

import (
	"context"
	"fmt"
	"time"

	"github.com/KCuppens/hookci/agent/internal/capacity"
	"github.com/KCuppens/hookci/agent/internal/protocol"
)

// capacityInterval is the shortest gap between two capacity frames.
const capacityInterval = 2 * time.Second

// CapacitySource is the capacity pool as the client uses it: the state to
// report and a way to learn that it changed.
type CapacitySource interface {
	Snapshot() capacity.Snapshot
	Watch(fn func(capacity.Snapshot)) (cancel func())
}

// BudgetHandler is implemented by a Handler that applies the budget override
// the hub sends: a nil part means no override of it. Like HandleLive it runs
// on the session goroutine and must return promptly.
type BudgetHandler interface {
	HandleBudget(cpus *float64, memoryBytes *int64)
}

// capacityFrame is the capacity report for s.
func capacityFrame(s capacity.Snapshot) protocol.Capacity {
	jobs := make([]protocol.CapacityJobsElem, 0, len(s.Jobs))
	for _, j := range s.Jobs {
		jobs = append(jobs, protocol.CapacityJobsElem{
			RunId:       j.Run,
			Lane:        j.Lane,
			Job:         j.Job,
			MinCpus:     j.MinCPUs,
			GrantedCpus: j.GrantedCPUs,
			MemoryBytes: int(j.MemoryBytes),
		})
	}
	return protocol.Capacity{
		HostCpus:            s.HostCPUs,
		HostMemoryBytes:     int(s.HostMemoryBytes),
		BudgetCpus:          s.BudgetCPUs,
		BudgetMemoryBytes:   int(s.BudgetMemoryBytes),
		GrantedCpus:         s.GrantedCPUs,
		ReservedMemoryBytes: int(s.ReservedMemoryBytes),
		MemAvailableBytes:   int(s.MemAvailableBytes),
		CpuPressure:         s.CPUPressure,
		MemPressure:         s.MemPressure,
		BackingOff:          s.BackingOff,
		Jobs:                jobs,
	}
}

// writeCapacity sends the current capacity on s. It is unsequenced: only the
// latest report matters, so a lost one is never replayed.
func (c *Client) writeCapacity(ctx context.Context, s *conn) error {
	b, err := protocol.Marshal("capacity", capacityFrame(c.cfg.Capacity.Snapshot()))
	if err != nil {
		return fmt.Errorf("hubclient: capacity: %w", err)
	}
	return s.write(ctx, b)
}

// capacityPacer spaces capacity frames at least capacityInterval apart: a
// change inside the gap is sent once the gap is over.
type capacityPacer struct {
	last  time.Time
	timer <-chan time.Time // nil unless a change waits for the gap to end
}

// changed reports whether to send now; otherwise it arms timer.
func (p *capacityPacer) changed(c *Client) bool {
	if p.timer != nil {
		return false
	}
	wait := capacityInterval - c.clk.Now().Sub(p.last)
	if wait <= 0 {
		return true
	}
	p.timer = c.clk.After(wait)
	return false
}

// sent records a frame written now and drops a waiting change, which that
// frame already carries.
func (p *capacityPacer) sent(c *Client) {
	p.last = c.clk.Now()
	p.timer = nil
}
