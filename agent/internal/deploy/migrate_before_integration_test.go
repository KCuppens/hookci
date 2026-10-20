//go:build integration

package deploy

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

// osExec runs deploy commands directly on the host.
type osExec struct{}

func (osExec) Run(ctx context.Context, _ string, argv []string, opts ExecOpts) error {
	return execx.OS{}.Run(ctx, execx.Cmd{Name: argv[0], Args: argv[1:], Dir: opts.Dir, Stdout: opts.Stdout, Stderr: opts.Stderr})
}

func docker(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// TestRunBeforeHook_PgDumpIntegration dumps a real postgres:16 database
// through the hook on a first deploy, then skips the hook on a push without
// migration files.
func TestRunBeforeHook_PgDumpIntegration(t *testing.T) {
	testutil.RequireIntegration(t)
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not in PATH")
	}
	name := "zeroci-itest-migrate-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	docker(t, "network", "create", name)
	t.Cleanup(func() { _ = exec.Command("docker", "network", "rm", name).Run() })
	docker(t, "run", "-d", "--name", name, "--network", name, "-e", "POSTGRES_PASSWORD=secret", "postgres:16")
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
	deadline := time.Now().Add(time.Minute)
	for exec.Command("docker", "exec", name, "pg_isready", "-U", "postgres").Run() != nil {
		if time.Now().After(deadline) {
			t.Fatal("postgres not ready after 1m")
		}
		time.Sleep(time.Second)
	}
	docker(t, "exec", name, "psql", "-U", "postgres", "-c", "CREATE TABLE items (id int); INSERT INTO items VALUES (1);")

	envFile := filepath.Join(t.TempDir(), "app.env")
	if err := os.WriteFile(envFile, []byte("PGHOST="+name+"\nPGUSER=postgres\nPGPASSWORD=secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The deploy unit gets env_file through systemd; the hook names the keys.
	t.Setenv("PGHOST", name)
	t.Setenv("PGUSER", "postgres")
	t.Setenv("PGPASSWORD", "secret")
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	dir := filepath.Join(t.TempDir(), "backups")
	var log bytes.Buffer
	sc := &StepContext{
		Run: store.DeployRun{RunID: "r1", Repo: "acme/web", Env: "production", SHA: "abc1234def567890"},
		Cfg: config.Deployment{
			EnvFile: &envFile,
			Migrate: &config.DeploymentMigrate{
				Run:   "./migrate up",
				Paths: []string{"db/migrations/**"},
				Before: &config.DeploymentMigrateBefore{
					Run: "pg_dump -Fc -f /backup/{env}-{sha7}-{ts}.dump postgres", OutputDir: &dir,
				},
			},
		},
		Outputs: map[string]string{},
		Exec:    osExec{},
		Log:     &log,
	}
	changes := &fakeChanges{files: []string{"src/app.ts"}}
	deps := MigrateBeforeDeps{Store: st, Changes: changes, Now: time.Now}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	ran, err := RunBeforeHook(ctx, sc, deps, "postgres:16", name)
	if err != nil || !ran {
		t.Fatalf("first deploy: ran = %v, err = %v\n%s", ran, err, log.String())
	}
	backups, err := st.ListMigrateBackups(ctx, "acme/web", "production")
	if err != nil || len(backups) != 1 {
		t.Fatalf("backups = %v, %v; want 1", backups, err)
	}
	dump, err := os.ReadFile(backups[0].Path)
	if err != nil || !bytes.HasPrefix(dump, []byte("PGDMP")) {
		t.Fatalf("dump %s: %v; want a pg_dump custom-format archive", backups[0].Path, err)
	}

	if err := st.SetDeployState(ctx, store.DeployState{Repo: "acme/web", Env: "production", LastSuccessSHA: "abc1234def567890"}); err != nil {
		t.Fatal(err)
	}
	sc.Run.RunID, sc.Run.SHA = "r2", "fedcba9876543210"
	sc.Outputs = map[string]string{}
	ran, err = RunBeforeHook(ctx, sc, deps, "postgres:16", name)
	if err != nil || ran || sc.Outputs["before_reason"] != "no_migration_changes" {
		t.Fatalf("second deploy: ran = %v, err = %v, reason = %q; want skipped", ran, err, sc.Outputs["before_reason"])
	}
}
