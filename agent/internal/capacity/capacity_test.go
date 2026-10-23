package capacity

import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/clock"
)

const gib = int64(1) << 30

type fakeHost struct {
	mu  sync.Mutex
	s   Sample
	err error
}

func (h *fakeHost) Sample() (Sample, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.s, h.err
}

func (h *fakeHost) set(s Sample) {
	h.mu.Lock()
	h.s = s
	h.mu.Unlock()
}

func roomy() *fakeHost { return &fakeHost{s: Sample{MemAvailable: 64 * gib}} }

// calm is a host with pressure stall information and nothing going on.
func calm() *fakeHost {
	return &fakeHost{s: Sample{MemTotal: 64 * gib, MemAvailable: 60 * gib, PSI: true}}
}

func acquire(t *testing.T, p *Pool, d Demand) *Grant {
	t.Helper()
	g, ok := p.TryAcquire(d)
	if !ok {
		t.Fatalf("demand %+v refused", d)
	}
	return g
}

func TestBudgetCapsCPUAndMemory(t *testing.T) {
	p := New(Options{CPUs: 6, MemoryBytes: 32 * gib, Host: roomy(), CPUCount: 8})
	four := acquire(t, p, Demand{CPUs: 4, MemoryBytes: 8 * gib})
	if _, ok := p.TryAcquire(Demand{CPUs: 3, MemoryBytes: gib}); ok {
		t.Fatal("admitted 7 cores on a 6-core budget")
	}
	acquire(t, p, Demand{CPUs: 2, MemoryBytes: 24 * gib})
	if _, ok := p.TryAcquire(Demand{MemoryBytes: 1}); ok {
		t.Fatal("admitted past a full memory budget")
	}
	four.Release()
	acquire(t, p, Demand{CPUs: 4, MemoryBytes: 8 * gib})
}

func TestAdmitsWhenNothingHeld(t *testing.T) {
	host := &fakeHost{s: Sample{MemAvailable: gib, Load1: 99}}
	p := New(Options{CPUs: 2, MemoryBytes: 4 * gib, Host: host, CPUCount: 8})
	big := acquire(t, p, Demand{CPUs: 16, MemoryBytes: 64 * gib})
	if _, ok := p.TryAcquire(Demand{CPUs: 0.1}); ok {
		t.Fatal("admitted next to an over-budget holder")
	}
	big.Release()
	acquire(t, p, Demand{CPUs: 16, MemoryBytes: 64 * gib})
}

func TestLiveCheckRefusesBusyHost(t *testing.T) {
	host := roomy()
	p := New(Options{Host: host, CPUCount: 8, MemReserve: 4 * gib})
	acquire(t, p, Demand{})

	host.set(Sample{MemAvailable: 6 * gib})
	if _, ok := p.TryAcquire(Demand{MemoryBytes: 3 * gib}); ok {
		t.Fatal("admitted into the memory reserve")
	}
	acquire(t, p, Demand{MemoryBytes: 2 * gib})

	host.set(Sample{MemAvailable: 64 * gib, Load1: 8})
	if _, ok := p.TryAcquire(Demand{}); ok {
		t.Fatal("admitted at a load equal to the CPU count")
	}
	host.set(Sample{MemAvailable: 64 * gib, Load1: 7.9})
	acquire(t, p, Demand{})

	host.mu.Lock()
	host.err = errors.New("no procfs")
	host.mu.Unlock()
	acquire(t, p, Demand{})
}

func TestReleaseWakesSubscribersUntilUnsubscribed(t *testing.T) {
	p := New(Options{CPUs: 1})
	var woke atomic.Int32
	unsub := p.Subscribe(func() { woke.Add(1) })
	acquire(t, p, Demand{CPUs: 1}).Release()
	if woke.Load() != 1 {
		t.Fatalf("woke %d times on release, want 1", woke.Load())
	}
	unsub()
	acquire(t, p, Demand{CPUs: 1}).Release()
	if woke.Load() != 1 {
		t.Fatal("woken after unsubscribing")
	}
}

func TestReleaseIsIdempotent(t *testing.T) {
	p := New(Options{CPUs: 2})
	g := acquire(t, p, Demand{CPUs: 2})
	g.Release()
	g.Release()
	acquire(t, p, Demand{CPUs: 2})
	if _, ok := p.TryAcquire(Demand{CPUs: 1}); ok {
		t.Fatal("a second Release returned a share it no longer held")
	}
}

func TestRunRechecksOnlyAfterRefusal(t *testing.T) {
	clk := clock.NewFake(time.Unix(0, 0))
	host := roomy()
	p := New(Options{Host: host, CPUCount: 8, Clock: clk})
	woke := make(chan struct{}, 16)
	p.Subscribe(func() { woke <- struct{}{} })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	// Without a refusal ticks wake nobody. Advance a while so the ticker
	// registered by Run has surely fired at least once.
	for range 20 {
		clk.Advance(RecheckInterval)
		time.Sleep(time.Millisecond)
	}
	select {
	case <-woke:
		t.Fatal("woken without a refusal")
	default:
	}

	acquire(t, p, Demand{})
	host.set(Sample{MemAvailable: 64 * gib, Load1: 100})
	if _, ok := p.TryAcquire(Demand{}); ok {
		t.Fatal("busy host admitted work")
	}
	deadline := time.After(5 * time.Second)
	for {
		clk.Advance(RecheckInterval)
		select {
		case <-woke:
			return
		case <-deadline:
			t.Fatal("refused work never rechecked")
		case <-time.After(time.Millisecond):
		}
	}
}

func TestProcHostParsesProcfs(t *testing.T) {
	root := t.TempDir()
	write := func(name, body string) {
		t.Helper()
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("meminfo", "MemTotal:       65536000 kB\nMemFree:         1000 kB\nMemAvailable:   33554432 kB\n")
	write("loadavg", "3.25 2.10 1.00 2/900 12345\n")
	s, err := ProcHost{Root: root}.Sample()
	if err != nil {
		t.Fatal(err)
	}
	if s.MemTotal != 64000*(1<<20) || s.MemAvailable != 32*gib || s.Load1 != 3.25 || s.PSI {
		t.Fatalf("got %+v, want 32 GiB available, load 3.25 and no PSI", s)
	}

	write("pressure/cpu", "some avg10=12.50 avg60=3.00 avg300=1.00 total=1234\n")
	write("pressure/memory", "some avg10=0.50 avg60=0.10 avg300=0.00 total=12\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")
	s, err = ProcHost{Root: root}.Sample()
	if err != nil {
		t.Fatal(err)
	}
	if !s.PSI || s.CPUPressure != 12.5 || s.MemPressure != 0.5 {
		t.Fatalf("got %+v, want PSI with cpu 12.5 and memory 0.5", s)
	}

	write("pressure/memory", "garbage\n")
	if s, err = (ProcHost{Root: root}).Sample(); err != nil || s.PSI {
		t.Fatalf("unreadable pressure gave %+v, %v; want no PSI and no error", s, err)
	}

	write("meminfo", "MemTotal:       65536000 kB\n")
	if _, err := (ProcHost{Root: root}).Sample(); err == nil {
		t.Fatal("meminfo without MemAvailable parsed")
	}
}

func TestBackoffHysteresis(t *testing.T) {
	host := calm()
	p := New(Options{Host: host, CPUCount: 8})
	acquire(t, p, Demand{})
	spike := func(cpu, mem float64, avail int64) {
		s := host.s
		s.CPUPressure, s.MemPressure, s.MemAvailable = cpu, mem, avail
		host.set(s)
	}
	refused := func(why string) {
		t.Helper()
		if _, ok := p.TryAcquire(Demand{}); ok {
			t.Fatalf("admitted while %s", why)
		}
	}

	acquire(t, p, Demand{})
	spike(41, 0, 60*gib)
	refused("cpu pressure was above 40")
	if !p.Snapshot().BackingOff {
		t.Fatal("not backing off under CPU pressure")
	}
	spike(25, 0, 60*gib)
	refused("cpu pressure was between the marks")
	spike(20, 0, 60*gib)
	acquire(t, p, Demand{})

	spike(0, 11, 60*gib)
	refused("memory pressure was above 10")
	spike(0, 4, 60*gib)
	refused("memory pressure was between the marks")
	spike(0, 3, 60*gib)
	acquire(t, p, Demand{})

	spike(0, 0, 6*gib)
	refused("less than 10% of memory was available")
	spike(0, 0, 9*gib)
	refused("less than 15% of memory was available")
	spike(0, 0, 10*gib)
	acquire(t, p, Demand{})
	if p.Snapshot().BackingOff {
		t.Fatal("still backing off after every signal cleared")
	}
}

func TestBackoffWithoutPSIUsesMemAvailableAndLoad(t *testing.T) {
	host := &fakeHost{s: Sample{MemTotal: 64 * gib, MemAvailable: 60 * gib}}
	p := New(Options{Host: host, CPUCount: 8})
	acquire(t, p, Demand{})
	host.set(Sample{MemTotal: 64 * gib, MemAvailable: 5 * gib})
	if _, ok := p.TryAcquire(Demand{}); ok {
		t.Fatal("admitted with 5 GiB of 64 available")
	}
	if s := p.Snapshot(); !s.BackingOff || s.CPUPressure != -1 || s.MemPressure != -1 {
		t.Fatalf("snapshot %+v: want backing off with no pressure readings", s)
	}
	host.set(Sample{MemTotal: 64 * gib, MemAvailable: 60 * gib, Load1: 8})
	if _, ok := p.TryAcquire(Demand{}); ok {
		t.Fatal("admitted at load 8 on 8 CPUs without PSI")
	}
	host.set(Sample{MemTotal: 64 * gib, MemAvailable: 60 * gib, Load1: 1})
	acquire(t, p, Demand{})
}

func TestRunEndsBackoffAndWakesWaiters(t *testing.T) {
	clk := clock.NewFake(time.Unix(0, 0))
	host := calm()
	p := New(Options{Host: host, CPUCount: 8, Clock: clk})
	woke := make(chan struct{}, 64)
	p.Subscribe(func() { woke <- struct{}{} })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { p.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	acquire(t, p, Demand{})
	host.set(Sample{MemTotal: 64 * gib, MemAvailable: 60 * gib, PSI: true, CPUPressure: 90})
	waitFor(t, clk, func() bool { return p.Snapshot().BackingOff })
	for len(woke) > 0 {
		<-woke
	}
	host.set(Sample{MemTotal: 64 * gib, MemAvailable: 60 * gib, PSI: true})
	waitFor(t, clk, func() bool { return !p.Snapshot().BackingOff })
	select {
	case <-woke:
	case <-time.After(5 * time.Second):
		t.Fatal("waiters were not woken when pressure cleared")
	}
}

func waitFor(t *testing.T, clk *clock.Fake, cond func() bool) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for !cond() {
		clk.Advance(RecheckInterval)
		select {
		case <-deadline:
			t.Fatal("condition never held")
		case <-time.After(time.Millisecond):
		}
	}
}

func granted(g *Grant) float64 { return g.CPUs() }

func near(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

func TestIdleBudgetIsLentUpToMaxAndTakenBack(t *testing.T) {
	p := New(Options{CPUs: 8, Host: calm(), CPUCount: 16})
	a := acquire(t, p, Demand{CPUs: 2, MaxCPUs: 5})
	if got := granted(a); !near(got, 5) {
		t.Fatalf("lone job granted %v cores, want its max 5", got)
	}
	if v := <-a.Changed(); !near(v, 5) {
		t.Fatalf("Changed delivered %v, want 5", v)
	}

	b := acquire(t, p, Demand{CPUs: 2, MaxCPUs: WholeBudget})
	// 8 budget - 4 minimums = 4 spare, split evenly: 2 each, within both ceilings.
	if !near(granted(a), 4) || !near(granted(b), 4) {
		t.Fatalf("grants %v and %v, want 4 and 4", granted(a), granted(b))
	}
	c := acquire(t, p, Demand{CPUs: 4})
	if !near(granted(a), 2) || !near(granted(b), 2) || !near(granted(c), 4) {
		t.Fatalf("grants %v %v %v, want minimums 2 2 4", granted(a), granted(b), granted(c))
	}
	if v := <-a.Changed(); !near(v, 2) {
		t.Fatalf("Changed delivered %v, want the shrink to 2", v)
	}
	c.Release()
	if !near(granted(a), 4) || !near(granted(b), 4) {
		t.Fatalf("grants %v and %v after release, want 4 and 4", granted(a), granted(b))
	}
}

func TestDemandWithoutMaxIsNeverLent(t *testing.T) {
	p := New(Options{CPUs: 8, Host: calm(), CPUCount: 8})
	g := acquire(t, p, Demand{CPUs: 2})
	if got := granted(g); !near(got, 2) {
		t.Fatalf("granted %v, want exactly 2", got)
	}
}

func TestNothingIsLentWithoutPressureSignalOrUnderBackoff(t *testing.T) {
	host := &fakeHost{s: Sample{MemTotal: 64 * gib, MemAvailable: 60 * gib}}
	p := New(Options{CPUs: 8, Host: host, CPUCount: 8})
	g := acquire(t, p, Demand{CPUs: 2, MaxCPUs: WholeBudget})
	if got := granted(g); !near(got, 2) {
		t.Fatalf("lent to a host that reports no PSI: %v", got)
	}

	host2 := calm()
	p = New(Options{CPUs: 8, Host: host2, CPUCount: 8})
	acquire(t, p, Demand{})
	g = acquire(t, p, Demand{CPUs: 2, MaxCPUs: WholeBudget})
	host2.set(Sample{MemTotal: 64 * gib, MemAvailable: 60 * gib, PSI: true, CPUPressure: 80})
	p.TryAcquire(Demand{})
	if got := granted(g); !near(got, 2) {
		t.Fatalf("grant %v under pressure, want the minimum 2", got)
	}
	host2.set(Sample{MemTotal: 64 * gib, MemAvailable: 60 * gib, PSI: true})
	p.TryAcquire(Demand{})
	if got := granted(g); !near(got, 8) {
		t.Fatalf("grant %v after pressure cleared, want 8", got)
	}
}

func TestSetBudgetResizesGrantsAndWakes(t *testing.T) {
	p := New(Options{CPUs: 4, Host: calm(), CPUCount: 16})
	g := acquire(t, p, Demand{CPUs: 2, MaxCPUs: WholeBudget})
	if !near(granted(g), 4) {
		t.Fatalf("granted %v, want 4", granted(g))
	}
	if _, ok := p.TryAcquire(Demand{CPUs: 3}); ok {
		t.Fatal("admitted past the budget")
	}
	var woke atomic.Int32
	p.Subscribe(func() { woke.Add(1) })
	p.SetBudget(10, 0)
	if woke.Load() != 1 {
		t.Fatalf("woke %d, want 1", woke.Load())
	}
	if !near(granted(g), 10) {
		t.Fatalf("granted %v after a bigger budget, want 10", granted(g))
	}
	acquire(t, p, Demand{CPUs: 3})
	p.SetBudget(2, 0)
	if !near(granted(g), 2) {
		t.Fatalf("granted %v after a smaller budget, want the minimum 2", granted(g))
	}
}

func TestSnapshot(t *testing.T) {
	host := &fakeHost{s: Sample{MemTotal: 64 * gib, MemAvailable: 50 * gib, PSI: true, CPUPressure: 7, MemPressure: 1}}
	p := New(Options{CPUs: 6, MemoryBytes: 16 * gib, Host: host, CPUCount: 12})
	if s := p.Snapshot(); s.HostCPUs != 12 || s.BudgetCPUs != 6 || s.BudgetMemoryBytes != 16*gib ||
		s.CPUPressure != -1 || s.HostMemoryBytes != 0 || len(s.Jobs) != 0 {
		t.Fatalf("before any sample: %+v", s)
	}
	acquire(t, p, Demand{CPUs: 1, MemoryBytes: 2 * gib, Run: "r1", Lane: "pr:o/r:1"})
	acquire(t, p, Demand{CPUs: 2, MaxCPUs: 4, MemoryBytes: 3 * gib, Run: "r1", Job: "test", Lane: "pr:o/r:1"})
	s := p.Snapshot()
	if s.HostMemoryBytes != 64*gib || s.MemAvailableBytes != 50*gib || s.CPUPressure != 7 || s.MemPressure != 1 {
		t.Fatalf("host figures: %+v", s)
	}
	if s.ReservedMemoryBytes != 5*gib || !near(s.GrantedCPUs, 5) || s.BackingOff {
		t.Fatalf("grants: %+v", s)
	}
	want := []JobGrant{
		{Run: "r1", Lane: "pr:o/r:1", MinCPUs: 1, GrantedCPUs: 1, MemoryBytes: 2 * gib},
		{Run: "r1", Job: "test", Lane: "pr:o/r:1", MinCPUs: 2, GrantedCPUs: 4, MemoryBytes: 3 * gib},
	}
	if len(s.Jobs) != 2 || s.Jobs[0] != want[0] || s.Jobs[1] != want[1] {
		t.Fatalf("jobs %+v, want %+v", s.Jobs, want)
	}
}

func TestWatchCoalescesAndStops(t *testing.T) {
	p := New(Options{CPUs: 4})
	got := make(chan Snapshot, 16)
	stop := p.Watch(func(s Snapshot) { got <- s })

	g := acquire(t, p, Demand{CPUs: 1, Run: "r"})
	select {
	case s := <-got:
		if len(s.Jobs) == 0 && len(p.Snapshot().Jobs) != 0 {
			// Coalesced to an older kick is fine only if a newer one follows.
			<-got
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no snapshot after an admission")
	}
	g.Release()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case s := <-got:
			if len(s.Jobs) == 0 {
				stop()
				stop()
				acquire(t, p, Demand{CPUs: 1})
				time.Sleep(20 * time.Millisecond)
				for len(got) > 0 {
					if s := <-got; len(s.Jobs) > 0 {
						t.Fatal("snapshot delivered after cancel")
					}
				}
				return
			}
		case <-deadline:
			t.Fatal("no snapshot after the release")
		}
	}
}
