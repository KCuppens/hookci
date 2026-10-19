package executor

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation/isolationtest"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func TestParseTimeout(t *testing.T) {
	def := 10 * time.Minute

	if got := ParseTimeout(nil, def); got != def {
		t.Errorf("expected default %v, got %v", def, got)
	}

	empty := ""
	if got := ParseTimeout(&empty, def); got != def {
		t.Errorf("expected default %v, got %v", def, got)
	}

	tenM := "10m"
	if got := ParseTimeout(&tenM, def); got != 10*time.Minute {
		t.Errorf("expected 10m, got %v", got)
	}

	secs := "300s"
	if got := ParseTimeout(&secs, def); got != 300*time.Second {
		t.Errorf("expected 300s, got %v", got)
	}

	rawSecs := "45"
	if got := ParseTimeout(&rawSecs, def); got != 45*time.Second {
		t.Errorf("expected 45s, got %v", got)
	}
}

func TestExecuteRunSuccess(t *testing.T) {
	ctx := context.Background()
	stateDir := t.TempDir()
	workDir := filepath.Join(stateDir, "workdir")

	db, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		t.Fatalf("Open db: %v", err)
	}
	defer db.Close()

	runID := "01j7execsuccess"
	run := store.Run{
		ID: runID, Repo: "owner/repo", SHA: "abc", Ref: "main", Event: "push",
		Kind: "check", TrustDomain: "trusted:owner/repo",
	}
	if err := db.CreateRun(ctx, run, []store.Job{{Name: "lint"}, {Name: "unit", Needs: []string{"lint"}}}); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	fakeIso := isolationtest.NewFake()
	leftover := isolation.UnitName(runID, "lint")
	fakeIso.Units = []isolation.Unit{
		{Name: leftover, Active: "active"},
		{Name: isolation.UnitName("other-run", "lint"), Active: "active"},
	}
	t.Setenv("ZEROCI_AGENT_ONLY", "agent-secret")
	exec := New(Options{
		StateDir:  stateDir,
		Store:     db,
		Isolation: fakeIso,
		Slots:     2,
	})

	cfg := &config.Config{ZeroCIConfig: config.ZeroCIConfig{
		Version: 1,
		Checks: &config.Checks{
			Setup: []config.SetupStep{{Run: "echo setup"}},
			Jobs: config.ChecksJobs{
				"lint": {Run: "go vet ./..."},
				"unit": {Run: "go test ./...", Needs: []string{"lint"}},
			},
		},
	}}
	err = exec.ExecuteRun(ctx, runID, cfg, workDir, true)
	if err != nil {
		t.Fatalf("ExecuteRun failed: %v", err)
	}

	// Verify fake isolation saw setup, lint, and unit
	if len(fakeIso.Runs) != 3 {
		t.Fatalf("expected 3 isolation runs, got %d", len(fakeIso.Runs))
	}
	if fakeIso.Runs[0].Job != "setup" {
		t.Errorf("expected first job to be setup, got %s", fakeIso.Runs[0].Job)
	}
	wantEnv := []string{"PATH=" + jobPATH, "HOME=/tmp"}
	for _, spec := range fakeIso.Runs {
		if !slices.Equal(spec.Env, wantEnv) {
			t.Errorf("%s env = %v, want exactly %v", spec.Job, spec.Env, wantEnv)
		}
	}
	if !slices.Equal(fakeIso.Stops, []string{leftover}) {
		t.Errorf("FinishRun stopped %v, want only this run's unit %s", fakeIso.Stops, leftover)
	}

	// Check final run state in DB
	savedRun, err := db.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if savedRun.State != store.RunSuccess {
		t.Errorf("expected run state success, got %s", savedRun.State)
	}
}

func TestExecuteRunSetupFailure(t *testing.T) {
	ctx := context.Background()
	stateDir := t.TempDir()
	workDir := filepath.Join(stateDir, "workdir")

	db, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		t.Fatalf("Open db: %v", err)
	}
	defer db.Close()

	runID := "01j7failsetup"
	run := store.Run{
		ID: runID, Repo: "owner/repo", SHA: "abc", Ref: "main", Event: "push",
		Kind: "check", TrustDomain: "trusted:owner/repo",
	}
	if err := db.CreateRun(ctx, run, []store.Job{{Name: "lint"}}); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	fakeIso := isolationtest.NewFake()
	fakeIso.Responses["setup"] = isolation.Result{ExitCode: 2}

	exec := New(Options{
		StateDir:  stateDir,
		Store:     db,
		Isolation: fakeIso,
	})

	cfg := &config.Config{ZeroCIConfig: config.ZeroCIConfig{
		Version: 1,
		Checks: &config.Checks{
			Setup: []config.SetupStep{{Run: "false"}},
			Jobs:  config.ChecksJobs{"lint": {Run: "go vet"}},
		},
	}}

	if err := exec.ExecuteRun(ctx, runID, cfg, workDir, false); err == nil {
		t.Fatalf("expected setup failure error, got nil")
	}
	if len(fakeIso.Runs) != 1 {
		t.Errorf("expected only the setup isolation run, got %d", len(fakeIso.Runs))
	}
	saved, err := db.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if saved.State != store.RunFailed || !strings.HasPrefix(saved.Reason, "setup failed: ") {
		t.Errorf("run = %s %q, want failed with a setup failed reason", saved.State, saved.Reason)
	}
	jobs, err := db.Jobs(ctx, runID)
	if err != nil {
		t.Fatalf("Jobs: %v", err)
	}
	if len(jobs) != 1 || jobs[0].State != store.JobSkipped {
		t.Errorf("jobs = %+v, want lint skipped", jobs)
	}
}

func TestExecuteRunJobFailure(t *testing.T) {
	ctx := context.Background()
	stateDir := t.TempDir()
	workDir := filepath.Join(stateDir, "workdir")

	db, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		t.Fatalf("Open db: %v", err)
	}
	defer db.Close()

	runID := "01j7failjob"
	run := store.Run{
		ID: runID, Repo: "owner/repo", SHA: "abc", Ref: "main", Event: "push",
		Kind: "check", TrustDomain: "trusted:owner/repo",
	}
	if err := db.CreateRun(ctx, run, []store.Job{{Name: "lint"}, {Name: "unit", Needs: []string{"lint"}}}); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	fakeIso := isolationtest.NewFake()
	fakeIso.Responses["lint"] = isolation.Result{ExitCode: 3}
	exec := New(Options{StateDir: stateDir, Store: db, Isolation: fakeIso})

	cfg := &config.Config{ZeroCIConfig: config.ZeroCIConfig{
		Version: 1,
		Checks: &config.Checks{
			Jobs: config.ChecksJobs{
				"lint": {Run: "go vet ./..."},
				"unit": {Run: "go test ./...", Needs: []string{"lint"}},
			},
		},
	}}
	if err := exec.ExecuteRun(ctx, runID, cfg, workDir, false); err == nil {
		t.Fatal("expected job failure error, got nil")
	}

	jobs, err := db.Jobs(ctx, runID)
	if err != nil {
		t.Fatalf("Jobs: %v", err)
	}
	got := map[string]store.Job{}
	for _, j := range jobs {
		got[j.Name] = j
	}
	if j := got["lint"]; j.State != store.JobFailed || j.Reason != "exit 3" || j.ExitCode == nil || *j.ExitCode != 3 {
		t.Errorf("lint = %+v, want failed, exit 3", j)
	}
	if j := got["unit"]; j.State != store.JobSkipped {
		t.Errorf("unit = %s, want skipped", j.State)
	}
}
