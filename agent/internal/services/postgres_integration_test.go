//go:build integration

package services

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

func TestPostgresIntegration(t *testing.T) {
	testutil.RequireIntegration(t)
	if _, err := exec.LookPath("docker"); err != nil {
		t.Fatalf("docker is required: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	runID := "integ" + time.Now().Format("150405")
	runDir := filepath.Join(t.TempDir(), "runs", runID)
	docker := Docker{Runner: execx.OS{}}
	p, err := StartPostgres(ctx, PostgresOptions{
		RunID:        runID,
		RunDir:       runDir,
		Tmpfs:        true,
		CPUs:         1,
		MemoryBytes:  512 << 20,
		ReadyTimeout: 60 * time.Second,
		Docker:       docker,
	})
	if err != nil {
		t.Fatalf("StartPostgres: %v", err)
	}
	t.Cleanup(func() { _ = p.Stop(context.Background()) })

	// Query through the bind-mounted socket in the run dir. Use the host psql
	// when installed, else a client container with no network that sees only
	// that socket dir.
	var psql *exec.Cmd
	if _, err := exec.LookPath("psql"); err == nil {
		psql = exec.CommandContext(ctx, "psql", "-tAc", "select 1")
		psql.Env = append(os.Environ(), p.Env()...)
	} else {
		psql = exec.CommandContext(ctx, "docker", "run", "--rm", "--network", "none",
			"-v", p.SocketDir+":/var/run/postgresql", DefaultPGImage,
			"psql", "-h", "/var/run/postgresql", "-U", "postgres", "-d", "postgres", "-tAc", "select 1")
	}
	var out bytes.Buffer
	psql.Stdout, psql.Stderr = &out, &out
	if err := psql.Run(); err != nil {
		t.Fatalf("psql: %v\n%s", err, out.String())
	}
	if got := strings.TrimSpace(out.String()); got != "1" {
		t.Errorf("select 1 = %q, want 1", got)
	}

	if err := p.Stop(ctx); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	ids, err := docker.ListByLabel(ctx, LabelRun+"="+runID)
	if err != nil {
		t.Fatalf("ListByLabel: %v", err)
	}
	if len(ids) != 0 {
		t.Errorf("containers left with label %s=%s: %v", LabelRun, runID, ids)
	}
}
