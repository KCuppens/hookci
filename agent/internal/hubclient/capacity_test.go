package hubclient

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/capacity"
)

type fakeCapacity struct {
	mu   sync.Mutex
	snap capacity.Snapshot
	fn   func(capacity.Snapshot)
}

func (f *fakeCapacity) Snapshot() capacity.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}

func (f *fakeCapacity) Watch(fn func(capacity.Snapshot)) func() {
	f.mu.Lock()
	f.fn = fn
	f.mu.Unlock()
	return func() {}
}

func (f *fakeCapacity) set(s capacity.Snapshot) {
	f.mu.Lock()
	f.snap = s
	fn := f.fn
	f.mu.Unlock()
	fn(s)
}

func (f *fakeCapacity) watched() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.fn != nil
}

const gib = 1 << 30

func idleSnapshot() capacity.Snapshot {
	return capacity.Snapshot{
		HostCPUs: 8, HostMemoryBytes: 16 * gib,
		BudgetCPUs: 4, BudgetMemoryBytes: 8 * gib,
		CPUPressure: -1, MemPressure: -1,
	}
}

type budgetHandler struct {
	recordingHandler
	got chan budgetCall
}

type budgetCall struct {
	cpus *float64
	mem  *int64
}

func (h *budgetHandler) HandleBudget(cpus *float64, mem *int64) { h.got <- budgetCall{cpus, mem} }

func frames(c *hubConn) <-chan map[string]any {
	out := make(chan map[string]any, 16)
	go func() {
		for {
			_, b, err := c.c.Read(context.Background())
			if err != nil {
				return
			}
			var m map[string]any
			if json.Unmarshal(b, &m) == nil {
				out <- m
			}
		}
	}()
	return out
}

func TestCapacityReported(t *testing.T) {
	x := newHarness(t)
	src := &fakeCapacity{snap: idleSnapshot()}
	cfg := x.client.cfg
	cfg.Capacity = src
	x.client = New(cfg, x.st, x.h, x.client.log)
	x.start(t)
	c := x.hub.next(t)
	hello := c.handshake(t)
	if hello["host_cpus"] != 8.0 || hello["host_memory_bytes"] != float64(16*gib) {
		t.Errorf("hello host = %v, %v; want 8 cores and 16 GiB", hello["host_cpus"], hello["host_memory_bytes"])
	}
	got := c.readFrame(t)
	if got["type"] != "capacity" || got["budget_cpus"] != 4.0 || got["mem_available_bytes"] != 0.0 || got["cpu_pressure"] != -1.0 {
		t.Fatalf("first frame = %v; want capacity with budget 4, unknown memory as 0 and pressure -1", got)
	}
	if _, ok := got["seq"]; ok {
		t.Errorf("capacity carries seq: %v", got)
	}

	waitFor(t, "watch", src.watched)
	in := frames(c)
	busy := idleSnapshot()
	busy.GrantedCPUs = 3
	busy.ReservedMemoryBytes = 2 * gib
	busy.Jobs = []capacity.JobGrant{{Run: "run_1", Lane: "push:o/r:main", Job: "unit/shard", MinCPUs: 1, GrantedCPUs: 3, MemoryBytes: 2 * gib}}
	src.set(busy)
	var next map[string]any
	advanceUntil(t, x.clk, "capacity after change", func() bool {
		select {
		case next = <-in:
			return true
		default:
			return false
		}
	})
	jobs, _ := next["jobs"].([]any)
	if next["type"] != "capacity" || next["granted_cpus"] != 3.0 || len(jobs) != 1 {
		t.Fatalf("frame after change = %v", next)
	}
	job := jobs[0].(map[string]any)
	if job["run_id"] != "run_1" || job["lane"] != "push:o/r:main" || job["job"] != "unit/shard" || job["granted_cpus"] != 3.0 {
		t.Errorf("job = %v; want run_1, its lane, unit/shard, 3 cores", job)
	}
}

func TestCapacityChangesAreSpaced(t *testing.T) {
	x := newHarness(t)
	src := &fakeCapacity{snap: idleSnapshot()}
	cfg := x.client.cfg
	cfg.Capacity = src
	x.client = New(cfg, x.st, x.h, x.client.log)
	x.start(t)
	c := x.hub.next(t)
	c.handshake(t)
	c.readFrame(t)
	waitFor(t, "watch", src.watched)
	in := frames(c)

	s := idleSnapshot()
	for _, cpus := range []float64{1, 2, 3} {
		s.GrantedCPUs = cpus
		src.set(s)
	}
	var next map[string]any
	advanceUntil(t, x.clk, "one capacity after the gap", func() bool {
		select {
		case next = <-in:
			return true
		default:
			return false
		}
	})
	if next["granted_cpus"] != 3.0 {
		t.Errorf("granted_cpus = %v, want the latest value 3", next["granted_cpus"])
	}
}

func TestBudgetFrameReachesHandler(t *testing.T) {
	x := newHarness(t)
	h := &budgetHandler{got: make(chan budgetCall, 4)}
	x.client = New(x.client.cfg, x.st, h, x.client.log)
	x.start(t)
	c := x.hub.next(t)
	c.handshake(t)

	c.send(t, `{"v":1,"type":"future_frame","x":1}`)
	c.send(t, `{"v":1,"type":"budget","cpus":2.5,"memory_bytes":4294967296}`)
	c.send(t, `{"v":1,"type":"budget","cpus":null,"memory_bytes":null}`)
	for i, check := range []func(budgetCall) bool{
		func(b budgetCall) bool { return b.cpus != nil && *b.cpus == 2.5 && b.mem != nil && *b.mem == 4*gib },
		func(b budgetCall) bool { return b.cpus == nil && b.mem == nil },
	} {
		select {
		case b := <-h.got:
			if !check(b) {
				t.Errorf("budget call %d = %+v", i, b)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("budget call %d never arrived", i)
		}
	}
	if !x.client.Connected() {
		t.Error("an unknown frame ended the session")
	}
}

func TestHelloWithoutCapacityOmitsHost(t *testing.T) {
	x := newHarness(t)
	x.start(t)
	hello := x.hub.next(t).handshake(t)
	if _, ok := hello["host_cpus"]; ok {
		t.Errorf("hello = %v; want no host_cpus without a capacity source", hello)
	}
}
