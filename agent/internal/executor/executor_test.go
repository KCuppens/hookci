package executor

import (
	"context"
	"path/filepath"
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

	dbPath := filepath.Join(stateDir, "test.db")
	db, err := store.Open(ctx, dbPath)
	if err != nil {
		t.Fatalf("Open db: %v", err)
	}
	defer db.Close()

	runID := "01j7execsuccess"
	run := &store.Run{
		ID:          runID,
		Repo:        "owner/repo",
		Ref:         "main",
		TrustDomain: store.TrustDomainLocal,
	}
	if err := db.CreateRun(ctx, run, []string{"lint", "unit"}); err != nil {
		t.Fatalf("CreateRun: %v", err)
	}

	fakeIso := isolationtest.NewFake()
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
	err = exec.ExecuteRun(ctx, runID, cfg, workDir, "local", true)
	if err != nil {
		t.Fatalf("ExecuteRun failed: %v", err)
	}

	// Verify fake isolation saw setup, lint, and unit
	if len(fakeIso.Runs) != 3 {
		t.Fatalf("expected 3 isolation runs, got %d", len(fakeIso.Runs))
	}
	if fakeIso.Runs[0].JobName != "setup" {
		t.Errorf("expected first job to be setup, got %s", fakeIso.Runs[0].JobName)
	}

	// Check final run state in DB
	savedRun, err := db.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("GetRun: %v", err)
	}
	if savedRun.State != store.RunStateSuccess {
		t.Errorf("expected run state Success, got %s", savedRun.State)
	}
}

func TestExecuteRunSetupFailure(t *testing.T) {
	ctx := context.Background()
	stateDir := t.TempDir()
	workDir := filepath.Join(stateDir, "workdir")

	fakeIso := isolationtest.NewFake()
	fakeIso.Responses["setup"] = isolation.Result{ExitCode: 2}

	exec := New(Options{
		StateDir:  stateDir,
		Isolation: fakeIso,
	})

	cfg := &config.Config{ZeroCIConfig: config.ZeroCIConfig{
		Version: 1,
		Checks: &config.Checks{
			Setup: []config.SetupStep{{Run: "false"}},
			Jobs:  config.ChecksJobs{"lint": {Run: "go vet"}},
		},
	}}

	err := exec.ExecuteRun(ctx, "01j7failsetup", cfg, workDir, "local", false)
	if err == nil {
		t.Fatalf("expected setup failure error, got nil")
	}
}
