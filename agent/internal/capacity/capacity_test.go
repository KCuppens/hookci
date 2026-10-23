package capacity

import (
	"context"
	"errors"
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

func TestBudgetCapsCPUAndMemory(t *testing.T) {
	p := New(Options{CPUs: 6, MemoryBytes: 32 * gib, Host: roomy(), CPUCount: 8})
	four := Demand{CPUs: 4, MemoryBytes: 8 * gib}
	if !p.TryAcquire(four) {
		t.Fatal("first demand refused")
	}
	if p.TryAcquire(Demand{CPUs: 3, MemoryBytes: gib}) {
		t.Fatal("admitted 7 cores on a 6-core budget")
	}
	if !p.TryAcquire(Demand{CPUs: 2, MemoryBytes: 24 * gib}) {
		t.Fatal("refused a demand that exactly fills the budget")
	}
	if p.TryAcquire(Demand{MemoryBytes: 1}) {
		t.Fatal("admitted past a full memory budget")
	}
	p.Release(four)
	if !p.TryAcquire(Demand{CPUs: 4, MemoryBytes: 8 * gib}) {
		t.Fatal("released share not reusable")
	}
}

func TestAdmitsWhenNothingHeld(t *testing.T) {
	host := &fakeHost{s: Sample{MemAvailable: gib, Load1: 99}}
	p := New(Options{CPUs: 2, MemoryBytes: 4 * gib, Host: host, CPUCount: 8})
	big := Demand{CPUs: 16, MemoryBytes: 64 * gib}
	if !p.TryAcquire(big) {
		t.Fatal("refused the only demand of an empty pool")
	}
	if p.TryAcquire(Demand{CPUs: 0.1}) {
		t.Fatal("admitted next to an over-budget holder")
	}
	p.Release(big)
	if !p.TryAcquire(big) {
		t.Fatal("refused after the pool emptied")
	}
}

func TestLiveCheckRefusesBusyHost(t *testing.T) {
	host := roomy()
	p := New(Options{Host: host, CPUCount: 8, MemReserve: 4 * gib})
	if !p.TryAcquire(Demand{}) {
		t.Fatal("first demand refused")
	}

	host.set(Sample{MemAvailable: 6 * gib})
	if p.TryAcquire(Demand{MemoryBytes: 3 * gib}) {
		t.Fatal("admitted into the memory reserve")
	}
	if !p.TryAcquire(Demand{MemoryBytes: 2 * gib}) {
		t.Fatal("refused a demand that leaves exactly the reserve")
	}

	host.set(Sample{MemAvailable: 64 * gib, Load1: 8})
	if p.TryAcquire(Demand{}) {
		t.Fatal("admitted at a load equal to the CPU count")
	}
	host.set(Sample{MemAvailable: 64 * gib, Load1: 7.9})
	if !p.TryAcquire(Demand{}) {
		t.Fatal("refused below the CPU count")
	}

	host.mu.Lock()
	host.err = errors.New("no procfs")
	host.mu.Unlock()
	if !p.TryAcquire(Demand{}) {
		t.Fatal("a failed sample refused work")
	}
}

func TestReleaseWakesSubscribersUntilUnsubscribed(t *testing.T) {
	p := New(Options{CPUs: 1})
	var woke atomic.Int32
	unsub := p.Subscribe(func() { woke.Add(1) })
	d := Demand{CPUs: 1}
	p.TryAcquire(d)
	p.Release(d)
	if woke.Load() != 1 {
		t.Fatalf("woke %d times on release, want 1", woke.Load())
	}
	unsub()
	p.TryAcquire(d)
	p.Release(d)
	if woke.Load() != 1 {
		t.Fatal("woken after unsubscribing")
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

	p.TryAcquire(Demand{})
	host.set(Sample{MemAvailable: 64 * gib, Load1: 100})
	if p.TryAcquire(Demand{}) {
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
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("meminfo", "MemTotal:       65536000 kB\nMemFree:         1000 kB\nMemAvailable:   33554432 kB\n")
	write("loadavg", "3.25 2.10 1.00 2/900 12345\n")
	s, err := ProcHost{Root: root}.Sample()
	if err != nil {
		t.Fatal(err)
	}
	if s.MemAvailable != 32*gib || s.Load1 != 3.25 {
		t.Fatalf("got %+v, want 32 GiB and load 3.25", s)
	}

	write("meminfo", "MemTotal:       65536000 kB\n")
	if _, err := (ProcHost{Root: root}).Sample(); err == nil {
		t.Fatal("meminfo without MemAvailable parsed")
	}
}
