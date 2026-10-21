package deploy

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/gc"
	"github.com/KCuppens/hookci/agent/internal/store"
)

func TestRunBestEffort_DoesNotAffectRunOutcome(t *testing.T) {
	for _, tc := range []struct {
		name string
		gc   func(r *queueRig, docker *execx.Fake) func(context.Context, store.DeployRun)
	}{
		{"gc fails", func(r *queueRig, docker *execx.Fake) func(context.Context, store.DeployRun) {
			created := t0.Add(time.Hour).Format("2006-01-02 15:04:05 -0700 MST")
			var images string
			for i := 1; i <= 4; i++ {
				images += fmt.Sprintf(`{"CreatedAt":%q,"ID":"sha256:%d","Repository":"web","Tag":"000000%d"}`+"\n", created, i, i)
			}
			docker.On("docker", []string{"image", "ls"}, execx.FakeResponse{Stdout: images})
			docker.On("docker", []string{"builder", "prune", "--help"}, execx.FakeResponse{Stdout: "--keep-storage"})
			docker.On("docker", []string{"image", "rm"}, execx.FakeResponse{Code: 1, Stderr: "image is in use"})
			docker.On("docker", []string{"builder", "prune", "--force"}, execx.FakeResponse{Err: errors.New("docker daemon gone")})
			c := &gc.Collector{Runner: docker, Store: r.store, StateDir: t.TempDir(), Clock: r.clock,
				Repos: func(context.Context) ([]gc.RepoEnv, error) {
					return []gc.RepoEnv{{Repo: "acme/web", Env: "production", Project: "web", Retain: 2}}, nil
				}}
			return func(ctx context.Context, _ store.DeployRun) { c.RunBestEffort(ctx) }
		}},
		{"hook panics", func(*queueRig, *execx.Fake) func(context.Context, store.DeployRun) {
			return func(context.Context, store.DeployRun) { panic("gc bug") }
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			r := newTestQueue(t)
			docker := &execx.Fake{}
			hook := tc.gc(r, docker)
			var seen []store.DeployRun
			r.sched.PostRun = func(ctx context.Context, run store.DeployRun) {
				if holder := r.lockHolder(t, run.Env); holder != "" {
					t.Errorf("PostRun ran while %q holds the env lock", holder)
				}
				seen = append(seen, run)
				hook(ctx, run)
			}

			r.insert(t, "a", "production", t0, store.DeployQueued)
			r.sched.Enqueue(ctx, "a", false)
			r.tick(t, ctx, 1)
			r.awaitStart(t)
			r.step("a", succeed)
			r.sched.Wait()

			r.wantState(t, "a", store.DeploySuccess)
			if len(seen) != 1 || seen[0].RunID != "a" || seen[0].State != store.DeploySuccess {
				t.Fatalf("PostRun saw %+v, want run a in Success", seen)
			}
			if tc.name == "gc fails" && !docker.Called("docker", "image", "rm") {
				t.Error("gc never tried to remove an image")
			}

			r.insert(t, "b", "production", t0.Add(time.Second), store.DeployQueued)
			r.sched.Enqueue(ctx, "b", false)
			r.tick(t, ctx, 1)
			r.awaitStart(t)
			r.step("b", func() error { return errors.New("boom") })
			r.sched.Wait()
			r.wantState(t, "b", store.DeployFailed)
			r.wantState(t, "a", store.DeploySuccess)
			if len(seen) != 2 || seen[1].RunID != "b" || seen[1].State != store.DeployFailed {
				t.Errorf("PostRun saw %+v, want b in Failed second", seen)
			}
		})
	}
}

func TestScheduler_PostRunSkipsUnfinishedRun(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := newTestQueue(t)
	called := false
	r.sched.PostRun = func(context.Context, store.DeployRun) { called = true }
	r.insert(t, "a", "production", t0, store.DeployQueued)
	r.sched.Enqueue(ctx, "a", false)
	r.tick(t, ctx, 1)
	r.awaitStart(t)
	cancel()
	r.sched.Wait()
	r.wantState(t, "a", store.DeployRunning)
	if called {
		t.Error("PostRun ran for a deploy cut short by shutdown")
	}
}
