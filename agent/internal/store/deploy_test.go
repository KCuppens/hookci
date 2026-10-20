package store

import (
	"context"
	"errors"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func testDeployRun(id, env, state string) DeployRun {
	return DeployRun{
		RunID: id, Repo: "acme/web", Env: env, SHA: "sha-" + id, Ref: "refs/heads/main",
		Strategy: "compose-bluegreen", State: state, CreatedAt: t0,
	}
}

func TestMigration_DeployTablesExist(t *testing.T) {
	s := openTestStore(t)
	for _, table := range []string{"deploy_runs", "deploy_steps", "deploy_state", "port_allocations", "env_locks"} {
		var n int
		if err := s.db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&n); err != nil {
			t.Fatalf("inspect %s: %v", table, err)
		}
		if n != 1 {
			t.Errorf("table %s missing", table)
		}
	}
}

func TestAllocatePort_IdempotentAndUnique(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)

	blue, err := s.AllocatePort(ctx, "acme/web", "prod", "blue", DefaultPortLo, DefaultPortHi)
	if err != nil {
		t.Fatalf("AllocatePort(blue): %v", err)
	}
	if blue != DefaultPortLo {
		t.Errorf("first port = %d, want lowest %d", blue, DefaultPortLo)
	}
	again, err := s.AllocatePort(ctx, "acme/web", "prod", "blue", DefaultPortLo, DefaultPortHi)
	if err != nil || again != blue {
		t.Errorf("AllocatePort(blue) again = %d, %v; want %d", again, err, blue)
	}
	green, err := s.AllocatePort(ctx, "acme/web", "prod", "green", DefaultPortLo, DefaultPortHi)
	if err != nil {
		t.Fatalf("AllocatePort(green): %v", err)
	}
	if green == blue {
		t.Errorf("green and blue share port %d", green)
	}

	tests := []struct {
		name, env, color string
		lo, hi           int
		want             int
		wantErr          string
	}{
		{name: "fills a 2-port range", env: "staging", color: "blue", lo: 21000, hi: 21001, want: 21000},
		{name: "second color takes the other port", env: "staging", color: "green", lo: 21000, hi: 21001, want: 21001},
		{name: "existing color in a full range", env: "staging", color: "blue", lo: 21000, hi: 21001, want: 21000},
		{name: "full range", env: "preview", color: "blue", lo: 21000, hi: 21001, wantErr: "21000-21001"},
		{name: "skips ports held by other envs", env: "preview", color: "blue", lo: 20000, hi: 20002, want: 20002},
		{name: "inverted range", env: "qa", color: "blue", lo: 21001, hi: 21000, wantErr: "invalid port range 21001-21000"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := s.AllocatePort(ctx, "acme/web", tt.env, tt.color, tt.lo, tt.hi)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want containing %q", err, tt.wantErr)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Errorf("port = %d, %v; want %d", got, err, tt.want)
			}
		})
	}
	if _, err := s.AllocatePort(ctx, "acme/api", "prod", "blue", 21000, 21001); !errors.Is(err, ErrPortsExhausted) {
		t.Errorf("exhausted err = %v, want ErrPortsExhausted", err)
	}
}

func TestEnvLock_Exclusive(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)

	assertHolder := func(want string) {
		t.Helper()
		got, held, err := s.EnvLockHolder(ctx, "acme/web", "prod")
		if err != nil {
			t.Fatalf("EnvLockHolder: %v", err)
		}
		if held != (want != "") || got != want {
			t.Errorf("holder = %q held=%v, want %q", got, held, want)
		}
	}

	assertHolder("")
	if ok, err := s.TryAcquireEnvLock(ctx, "acme/web", "prod", "r1", t0); err != nil || !ok {
		t.Fatalf("first acquire = %v, %v; want true", ok, err)
	}
	if ok, err := s.TryAcquireEnvLock(ctx, "acme/web", "prod", "r2", t0); err != nil || ok {
		t.Errorf("second acquire = %v, %v; want false", ok, err)
	}
	if ok, err := s.TryAcquireEnvLock(ctx, "acme/web", "staging", "r3", t0); err != nil || !ok {
		t.Errorf("acquire other env = %v, %v; want true", ok, err)
	}
	if err := s.ReleaseEnvLock(ctx, "acme/web", "prod", "r2"); err != nil {
		t.Fatalf("release by non-holder: %v", err)
	}
	assertHolder("r1")
	if err := s.ReleaseEnvLock(ctx, "acme/web", "prod", "r1"); err != nil {
		t.Fatalf("release by holder: %v", err)
	}
	assertHolder("")
	if ok, err := s.TryAcquireEnvLock(ctx, "acme/web", "prod", "r2", t0); err != nil || !ok {
		t.Errorf("acquire after release = %v, %v; want true", ok, err)
	}
	assertHolder("r2")
}

func TestSteps_BeginBeforeFinish(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "agent.db")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := s.BeginStep(ctx, "r1", 0, "build", map[string]string{"image": "web:abc1234"}, t0); err != nil {
		t.Fatalf("BeginStep(0): %v", err)
	}
	if err := s.FinishStep(ctx, "r1", 0, StepDone, map[string]string{"image": "web:abc1234"}, t0.Add(time.Second)); err != nil {
		t.Fatalf("FinishStep(0): %v", err)
	}
	if err := s.BeginStep(ctx, "r1", 1, "prepare", map[string]string{"color": "green", "port": "20001"}, t0.Add(2*time.Second)); err != nil {
		t.Fatalf("BeginStep(1): %v", err)
	}
	if err := s.Close(); err != nil { // simulated crash while step 1 runs
		t.Fatalf("Close: %v", err)
	}

	s, err = Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	steps, err := s.ListSteps(ctx, "r1")
	if err != nil {
		t.Fatalf("ListSteps: %v", err)
	}
	want := []DeployStep{
		{RunID: "r1", Index: 0, Name: "build", Status: StepDone, Outputs: map[string]string{"image": "web:abc1234"},
			StartedAt: t0.Truncate(time.Millisecond), FinishedAt: t0.Add(time.Second).Truncate(time.Millisecond)},
		{RunID: "r1", Index: 1, Name: "prepare", Status: StepRunning, Outputs: map[string]string{"color": "green", "port": "20001"},
			StartedAt: t0.Add(2 * time.Second).Truncate(time.Millisecond)},
	}
	if !slices.EqualFunc(steps, want, stepEqual) {
		t.Errorf("steps after reopen = %+v, want %+v", steps, want)
	}

	if err := s.BeginStep(ctx, "r1", 1, "prepare", nil, t0.Add(3*time.Second)); err != nil {
		t.Fatalf("BeginStep(1) on resume: %v", err)
	}
	if err := s.FinishStep(ctx, "r1", 1, StepFailed, nil, t0.Add(4*time.Second)); err != nil {
		t.Fatalf("FinishStep(1): %v", err)
	}
	steps, err = s.ListSteps(ctx, "r1")
	if err != nil {
		t.Fatalf("ListSteps: %v", err)
	}
	if got := steps[1]; got.Status != StepFailed || got.Outputs == nil || len(got.Outputs) != 0 ||
		!got.StartedAt.Equal(t0.Add(3*time.Second).Truncate(time.Millisecond)) {
		t.Errorf("resumed step = %+v, want failed with empty outputs started at +3s", got)
	}
	if err := s.FinishStep(ctx, "r1", 7, StepDone, nil, t0); !errors.Is(err, ErrNotFound) {
		t.Errorf("FinishStep on unbegun step err = %v, want ErrNotFound", err)
	}
	if err := s.FinishStep(ctx, "r1", 0, StepRunning, nil, t0); err == nil {
		t.Error("FinishStep with status running succeeded")
	}
}

func stepEqual(a, b DeployStep) bool {
	return a.RunID == b.RunID && a.Index == b.Index && a.Name == b.Name && a.Status == b.Status &&
		maps.Equal(a.Outputs, b.Outputs) && a.StartedAt.Equal(b.StartedAt) && a.FinishedAt.Equal(b.FinishedAt)
}

func TestListDeployRunsInStates(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	for i, st := range []string{DeployQueued, DeployRunning, DeployVerifying, DeployRollingBack, DeploySuccess, DeployFailed, DeployInterrupted} {
		r := testDeployRun("r"+string(rune('0'+i)), "prod", st)
		r.CreatedAt = t0.Add(time.Duration(i) * time.Second)
		if err := s.InsertDeployRun(ctx, r); err != nil {
			t.Fatalf("InsertDeployRun: %v", err)
		}
	}

	tests := []struct {
		name   string
		states []string
		want   []string
	}{
		{name: "active", states: []string{DeployRunning, DeployVerifying, DeployRollingBack}, want: []string{"r1", "r2", "r3"}},
		{name: "single", states: []string{DeployQueued}, want: []string{"r0"}},
		{name: "terminal", states: []string{DeployInterrupted, DeployFailed}, want: []string{"r5", "r6"}},
		{name: "no match", states: []string{DeploySuperseded}, want: nil},
		{name: "no states", states: nil, want: nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runs, err := s.ListDeployRunsInStates(ctx, tt.states...)
			if err != nil {
				t.Fatalf("ListDeployRunsInStates: %v", err)
			}
			var got []string
			for _, r := range runs {
				if !slices.Contains(tt.states, r.State) {
					t.Errorf("run %s in state %s returned", r.RunID, r.State)
				}
				got = append(got, r.RunID)
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("runs = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDeployRun_RoundTripAndStateTimes(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	in := testDeployRun("r1", "prod", DeployQueued)
	in.Attempt = 2
	in.PrevColor, in.TargetColor = "blue", "green"
	if err := s.InsertDeployRun(ctx, in); err != nil {
		t.Fatalf("InsertDeployRun: %v", err)
	}
	if err := s.InsertDeployRun(ctx, testDeployRun("r2", "prod", "Bogus")); err == nil {
		t.Error("InsertDeployRun with unknown state succeeded")
	}

	got, err := s.GetDeployRun(ctx, "r1")
	if err != nil {
		t.Fatalf("GetDeployRun: %v", err)
	}
	in.CreatedAt = in.CreatedAt.Truncate(time.Millisecond)
	if got != in {
		t.Errorf("GetDeployRun = %+v, want %+v", got, in)
	}

	start, end := t0.Add(time.Minute).Truncate(time.Millisecond), t0.Add(2*time.Minute).Truncate(time.Millisecond)
	if err := s.SetDeployRunState(ctx, "r1", DeployRunning, "", start); err != nil {
		t.Fatalf("SetDeployRunState(Running): %v", err)
	}
	if err := s.SetDeployRunState(ctx, "r1", DeployFailed, "deployments.prod: step health failed: timeout", end); err != nil {
		t.Fatalf("SetDeployRunState(Failed): %v", err)
	}
	got, err = s.GetDeployRun(ctx, "r1")
	if err != nil {
		t.Fatalf("GetDeployRun: %v", err)
	}
	if got.State != DeployFailed || got.Error != "deployments.prod: step health failed: timeout" ||
		!got.StartedAt.Equal(start) || !got.FinishedAt.Equal(end) {
		t.Errorf("after Failed = %+v", got)
	}

	if err := s.SetDeployRunState(ctx, "r1", DeployQueued, "", end); err != nil {
		t.Fatalf("SetDeployRunState(Queued): %v", err)
	}
	got, _ = s.GetDeployRun(ctx, "r1")
	if got.Error != "" || !got.FinishedAt.IsZero() || !got.StartedAt.Equal(start) {
		t.Errorf("after requeue = %+v, want error and finished_at cleared", got)
	}

	if _, err := s.GetDeployRun(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetDeployRun(missing) err = %v, want ErrNotFound", err)
	}
	if err := s.SetDeployRunState(ctx, "missing", DeployRunning, "", start); !errors.Is(err, ErrNotFound) {
		t.Errorf("SetDeployRunState(missing) err = %v, want ErrNotFound", err)
	}
}

func TestDeployState_RoundTrip(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "agent.db")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, ok, err := s.GetDeployState(ctx, "acme/web", "prod"); err != nil || ok {
		t.Fatalf("GetDeployState before set = %v, %v; want not found", ok, err)
	}

	first := DeployState{Repo: "acme/web", Env: "prod", ActiveColor: "blue", LastSuccessSHA: "sha1", LastSuccessRun: "r1",
		UpdatedAt: t0.Truncate(time.Millisecond)}
	second := DeployState{Repo: "acme/web", Env: "prod", ActiveColor: "green", LastSuccessSHA: "sha2", LastSuccessRun: "r2",
		UpdatedAt: t0.Add(time.Hour).Truncate(time.Millisecond)}
	for _, st := range []DeployState{first, second} {
		if err := s.SetDeployState(ctx, st); err != nil {
			t.Fatalf("SetDeployState: %v", err)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	s, err = Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	got, ok, err := s.GetDeployState(ctx, "acme/web", "prod")
	if err != nil || !ok {
		t.Fatalf("GetDeployState = %v, %v", ok, err)
	}
	if got != second {
		t.Errorf("GetDeployState = %+v, want %+v", got, second)
	}
	if _, ok, _ := s.GetDeployState(ctx, "acme/web", "staging"); ok {
		t.Error("staging state found, want none")
	}
}
