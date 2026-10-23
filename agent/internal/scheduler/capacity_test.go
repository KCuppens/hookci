package scheduler

import (
	"context"
	"log/slog"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/capacity"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// newPoolHarness is newHarness with a CPU budget and per-job demands; the
// setup asks for one core. asked receives every job the scheduler asked a
// demand for.
func newPoolHarness(t *testing.T, slots int, cpus float64, demand map[string]float64) (*harness, *capacity.Pool, <-chan string) {
	t.Helper()
	clock := newFakeClock()
	db, err := store.Open(filepath.Join(t.TempDir(), "agent.db"), store.WithClock(clock.Now))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	pool := capacity.New(capacity.Options{CPUs: cpus})
	asked := make(chan string, 256)
	r := newFakeRunner()
	s := New(db, r, Options{
		Slots:  slots,
		Clock:  clock,
		Logger: slog.New(slog.DiscardHandler),
		Pool:   pool,
		Demand: func(job string) capacity.Demand {
			select {
			case asked <- job:
			default:
			}
			if job == "" {
				return capacity.Demand{CPUs: 1}
			}
			return capacity.Demand{CPUs: demand[job]}
		},
	})
	t.Cleanup(func() { _ = s.Close() })
	return &harness{t: t, ctx: context.Background(), db: db, runner: r, s: s}, pool, asked
}

// waitAsked blocks until the scheduler asks for job's demand and fails if it
// asks for one of skipped first.
func waitAsked(t *testing.T, asked <-chan string, job string, skipped ...string) {
	t.Helper()
	deadline := time.After(waitTimeout)
	for {
		select {
		case got := <-asked:
			if got == job {
				return
			}
			if slices.Contains(skipped, got) {
				t.Fatalf("asked for %q before %q", got, job)
			}
		case <-deadline:
			t.Fatalf("never asked for %q", job)
		}
	}
}

func TestPoolHoldsJobsPastBudgetInOrder(t *testing.T) {
	h, pool, asked := newPoolHarness(t, 4, 4, map[string]float64{"big": 3, "mid": 2, "small": 1})
	id := h.create(pushRun("r1", "sha1", "ref1"), job("big"), job("mid"), job("small"))
	h.submit(id)

	h.runner.release(t, "r1:setup")
	h.runner.waitStarted(t, "r1:big")
	// mid does not fit next to big; small would, but order within a run is
	// strict so mid is not passed over.
	waitAsked(t, asked, "mid", "small")
	if got := h.runner.Starts(); !slices.Equal(got, []string{"r1:setup", "r1:big"}) {
		t.Fatalf("starts = %v, want setup then big only", got)
	}

	h.runner.release(t, "r1:big")
	h.runner.waitStarted(t, "r1:mid")
	h.runner.waitStarted(t, "r1:small")
	h.runner.release(t, "r1:mid")
	h.runner.release(t, "r1:small")
	if st := h.wait(id); st != store.RunSuccess {
		t.Fatalf("run = %s, want success", st)
	}
	h.idle()

	// Every share went back: the whole budget fits again next to a holder.
	_, first := pool.TryAcquire(capacity.Demand{CPUs: 1})
	_, second := pool.TryAcquire(capacity.Demand{CPUs: 3})
	if !first || !second {
		t.Fatal("pool still holds shares after the run")
	}
}

func TestPoolReleasesShareOfCancelledJob(t *testing.T) {
	h, pool, _ := newPoolHarness(t, 4, 4, map[string]float64{"j0": 4})
	id := h.create(pushRun("r1", "sha1", "ref1"), job("j0"))
	h.submit(id)
	h.runner.release(t, "r1:setup")
	h.runner.waitStarted(t, "r1:j0")
	if err := h.s.Cancel(h.ctx, id, "user cancelled"); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if st := h.wait(id); st != store.RunCancelled {
		t.Fatalf("run = %s, want cancelled", st)
	}
	h.idle()
	_, first := pool.TryAcquire(capacity.Demand{CPUs: 1})
	_, second := pool.TryAcquire(capacity.Demand{CPUs: 3})
	if !first || !second {
		t.Fatal("cancelled job kept its share")
	}
}
