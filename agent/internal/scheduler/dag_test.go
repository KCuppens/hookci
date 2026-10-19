package scheduler

import (
	"slices"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// diamond is a -> b,c -> d, listed out of order on purpose.
func diamond() []store.Job {
	return []store.Job{job("d", "b", "c"), job("c", "a"), job("b", "a"), job("a")}
}

func mustGraph(t *testing.T, jobs []store.Job) *Graph {
	t.Helper()
	g, err := NewGraph(jobs)
	if err != nil {
		t.Fatalf("NewGraph: %v", err)
	}
	return g
}

func wantReady(t *testing.T, g *Graph, want ...string) {
	t.Helper()
	if got := g.Ready(); !slices.Equal(got, want) {
		t.Fatalf("Ready() = %v, want %v", got, want)
	}
}

func TestGraphReadyOrder(t *testing.T) {
	g := mustGraph(t, diamond())

	wantReady(t, g, "a")
	g.MarkRunning("a")
	wantReady(t, g)
	g.MarkDone("a", store.JobSuccess)

	wantReady(t, g, "b", "c")
	g.MarkRunning("b")
	g.MarkRunning("c")
	g.MarkDone("c", store.JobSuccess)
	wantReady(t, g)
	g.MarkDone("b", store.JobSuccess)

	wantReady(t, g, "d")
	if g.Done() {
		t.Fatal("Done() before d finished")
	}
	g.MarkRunning("d")
	g.MarkDone("d", store.JobSuccess)
	wantReady(t, g)
	if !g.Done() || g.Final() != store.RunSuccess {
		t.Fatalf("Done() = %v, Final() = %s, want true, success", g.Done(), g.Final())
	}
}

func TestGraphFailureSkipsDependents(t *testing.T) {
	g := mustGraph(t, append(diamond(), job("e", "d")))
	g.MarkRunning("a")
	g.MarkDone("a", store.JobSuccess)
	g.MarkRunning("b")
	g.MarkRunning("c")

	if skipped := g.MarkDone("b", store.JobFailed); !slices.Equal(skipped, []string{"d", "e"}) {
		t.Fatalf("MarkDone(b, failed) skipped %v, want [d e]", skipped)
	}
	if g.Done() {
		t.Fatal("Done() while c is still running")
	}
	g.MarkDone("c", store.JobSuccess)
	wantReady(t, g)
	if !g.Done() || g.Final() != store.RunFailed {
		t.Fatalf("Done() = %v, Final() = %s, want true, failed", g.Done(), g.Final())
	}
}

func TestGraphCancelledSkipsDependents(t *testing.T) {
	g := mustGraph(t, diamond())
	g.MarkRunning("a")
	if skipped := g.MarkDone("a", store.JobCancelled); !slices.Equal(skipped, []string{"b", "c", "d"}) {
		t.Fatalf("MarkDone(a, cancelled) skipped %v, want [b c d]", skipped)
	}
	if !g.Done() || g.Final() != store.RunFailed {
		t.Fatalf("Done() = %v, Final() = %s, want true, failed", g.Done(), g.Final())
	}
}

func TestGraphAbandon(t *testing.T) {
	g := mustGraph(t, diamond())
	g.MarkRunning("a")
	if got := g.Abandon(store.JobSkipped); !slices.Equal(got, []string{"b", "c", "d"}) {
		t.Fatalf("Abandon() = %v, want [b c d]", got)
	}
	if g.Done() {
		t.Fatal("Done() while a is still running")
	}
	g.MarkDone("a", store.JobCancelled)
	if !g.Done() {
		t.Fatal("Done() = false after every job settled")
	}
}

func TestGraphEmpty(t *testing.T) {
	g := mustGraph(t, nil)
	if !g.Done() || g.Final() != store.RunSuccess {
		t.Fatalf("empty graph Done() = %v, Final() = %s, want true, success", g.Done(), g.Final())
	}
}

func TestGraphCycleRejected(t *testing.T) {
	if _, err := NewGraph([]store.Job{job("a", "b"), job("b", "a")}); err == nil {
		t.Fatal("NewGraph accepted a needs b, b needs a")
	}
}

func TestGraphInvalidJobsRejected(t *testing.T) {
	for name, jobs := range map[string][]store.Job{
		"unknown need": {job("a", "missing")},
		"duplicate":    {job("a"), job("a")},
		"self need":    {job("a", "a")},
	} {
		if _, err := NewGraph(jobs); err == nil {
			t.Errorf("%s: NewGraph accepted %v", name, jobs)
		}
	}
}
