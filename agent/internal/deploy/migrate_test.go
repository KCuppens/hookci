package deploy

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

var hookNow = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

const hookCmd = `pg_dump -Fc -f /backup/{env}-{sha7}-{ts}.dump "$DATABASE_URL"`

// hookEnv is the env_file of the hook rig; its values must never reach argv.
const hookEnv = "DATABASE_URL=postgres://app:s3cret-pw@db/app\nAPI_TOKEN=tok-9f8e7d\n"

func TestShouldRunBefore(t *testing.T) {
	paths := []string{"packages/db/drizzle/**"}
	for _, tc := range []struct {
		name      string
		paths     []string
		prevSHA   string
		files     []string
		truncated bool
		listErr   error
		run       bool
		reason    string
	}{
		{"no paths", nil, "prev", []string{"README.md"}, false, nil, true, "no_paths"},
		{"first deploy", paths, "", nil, false, nil, true, "first_deploy"},
		{"diff error", paths, "prev", nil, false, errors.New("github: 502"), true, "diff_error"},
		{"diff truncated", paths, "prev", []string{"README.md"}, true, nil, true, "diff_truncated"},
		{"paths matched", paths, "prev", []string{"README.md", "packages/db/drizzle/0007_x.sql"}, false, nil, true, "paths_matched"},
		{"no migration changes", paths, "prev", []string{"apps/web/page.tsx"}, false, nil, false, "no_migration_changes"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run, reason := shouldRunBefore(tc.paths, tc.prevSHA, tc.files, tc.truncated, tc.listErr)
			if run != tc.run || reason != tc.reason {
				t.Fatalf("shouldRunBefore = %v, %q; want %v, %q", run, reason, tc.run, tc.reason)
			}
		})
	}
}

func TestExpandBackupTemplate(t *testing.T) {
	got := expandBackupTemplate("{env}/{sha7}/{ts}/{env}", store.DeployRun{Env: "staging", SHA: "0123456789"},
		time.Date(2026, 5, 6, 7, 8, 9, 0, time.FixedZone("CEST", 2*3600)))
	if want := "staging/0123456/20260506T050809Z/staging"; got != want {
		t.Fatalf("expandBackupTemplate = %q, want %q", got, want)
	}
}

// hookExec records argv and runs write, standing in for the backup
// container.
type hookExec struct {
	calls [][]string
	write func(argv []string) error
}

func (e *hookExec) Run(_ context.Context, _ string, argv []string, _ ExecOpts) error {
	e.calls = append(e.calls, slices.Clone(argv))
	if e.write != nil {
		return e.write(argv)
	}
	return nil
}

type fakeChanges struct {
	files []string
	calls int
}

func (f *fakeChanges) ChangedFiles(context.Context, string, string, string) ([]string, bool, error) {
	f.calls++
	return f.files, false, nil
}

type hookRig struct {
	store   *store.Store
	sc      *StepContext
	deps    MigrateBeforeDeps
	exec    *hookExec
	changes *fakeChanges
	dir     string
	log     bytes.Buffer
}

// newHookRig sets up a deploy of abc1234… to production of acme/web whose
// last success is prev, with migrate.paths packages/db/drizzle/**.
func newHookRig(t *testing.T, retain int) *hookRig {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ctx := context.Background()
	if err := st.SetDeployState(ctx, store.DeployState{Repo: "acme/web", Env: "production", LastSuccessSHA: "prev"}); err != nil {
		t.Fatal(err)
	}
	r := &hookRig{store: st, exec: &hookExec{}, changes: &fakeChanges{}, dir: filepath.Join(t.TempDir(), "backups")}
	envFile := writeEnvFile(t, hookEnv)
	stubStat(t, fakeInfo{mode: 0o600, uid: 0})
	r.sc = &StepContext{
		Run: store.DeployRun{RunID: "r9", Repo: "acme/web", Env: "production", SHA: "abc1234def567890"},
		Cfg: config.Deployment{
			EnvFile: &envFile,
			Migrate: &config.DeploymentMigrate{
				Run:   "./migrate up",
				Paths: []string{"packages/db/drizzle/**"},
				Before: &config.DeploymentMigrateBefore{
					Run: hookCmd, Image: new("postgres:16"), OutputDir: &r.dir, Retain: retain,
				},
			},
		},
		Outputs: map[string]string{"image": "app:abc1234"},
		Exec:    r.exec,
		Log:     &r.log,
	}
	r.deps = MigrateBeforeDeps{Store: st, Changes: r.changes, Now: func() time.Time { return hookNow }}
	// The fake container writes the file the command names, as of hookNow.
	r.exec.write = func(argv []string) error {
		cmd := argv[len(argv)-1]
		i := strings.Index(cmd, "/backup/")
		name := strings.Fields(cmd[i+len("/backup/"):])[0]
		return writeAt(filepath.Join(r.dir, name), hookNow)
	}
	return r
}

func writeAt(path string, at time.Time) error {
	if err := os.WriteFile(path, []byte("dump"), 0o600); err != nil {
		return err
	}
	return os.Chtimes(path, at, at)
}

func (r *hookRig) backups(t *testing.T) []store.MigrateBackup {
	t.Helper()
	got, err := r.store.ListMigrateBackups(context.Background(), "acme/web", "production")
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestRunBeforeHook_Skips(t *testing.T) {
	r := newHookRig(t, 10)
	r.changes.files = []string{"apps/web/page.tsx"}
	ran, err := RunBeforeHook(context.Background(), r.sc, r.deps, "app:abc1234", "shared")
	if err != nil || ran {
		t.Fatalf("RunBeforeHook = %v, %v; want a skip", ran, err)
	}
	if len(r.exec.calls) != 0 {
		t.Fatalf("executor calls = %v, want none", r.exec.calls)
	}
	if r.changes.calls != 1 {
		t.Fatalf("ChangedFiles calls = %d, want 1", r.changes.calls)
	}
	if got := r.sc.Outputs["before_ran"]; got != "false" {
		t.Fatalf("before_ran = %q, want false", got)
	}
	if got := r.sc.Outputs["before_reason"]; got != "no_migration_changes" {
		t.Fatalf("before_reason = %q, want no_migration_changes", got)
	}
	if len(r.backups(t)) != 0 {
		t.Fatal("a skipped hook recorded a backup")
	}
}

func TestRunBeforeHook_RunsAndRecords(t *testing.T) {
	r := newHookRig(t, 10)
	r.changes.files = []string{"packages/db/drizzle/0007_x.sql"}
	ran, err := RunBeforeHook(context.Background(), r.sc, r.deps, "app:abc1234", "shared")
	if err != nil || !ran {
		t.Fatalf("RunBeforeHook = %v, %v; want a run\n%s", ran, err, r.log.String())
	}
	const file = "production-abc1234-20260101T000000Z.dump"
	want := []string{"docker", "run", "--rm", "--network", "shared", "-e", "API_TOKEN", "-e", "DATABASE_URL",
		"-v", r.dir + ":/backup", "postgres:16", "sh", "-c", `pg_dump -Fc -f /backup/` + file + ` "$DATABASE_URL"`}
	if len(r.exec.calls) != 1 || !slices.Equal(r.exec.calls[0], want) {
		t.Fatalf("argv = %q, want %q", r.exec.calls, want)
	}
	for _, value := range []string{"s3cret-pw", "tok-9f8e7d", *r.sc.Cfg.EnvFile} {
		for _, arg := range r.exec.calls[0] {
			if strings.Contains(arg, value) {
				t.Fatalf("argv %q carries env_file content or path %q", r.exec.calls[0], value)
			}
		}
	}
	backups := r.backups(t)
	if len(backups) != 1 {
		t.Fatalf("backups = %+v, want 1", backups)
	}
	b := backups[0]
	if b.Path != filepath.Join(r.dir, file) || b.RunID != "r9" || b.SHA != "abc1234def567890" || !b.CreatedAt.Equal(hookNow) {
		t.Fatalf("backup = %+v", b)
	}
	for key, want := range map[string]string{"before_ran": "true", "before_reason": "paths_matched", "backup_files": file} {
		if got := r.sc.Outputs[key]; got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	info, err := os.Stat(r.dir)
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("output_dir = %v, %v; want created with mode 0700", info, err)
	}
}

// A shared output_dir can get another environment's dump, or a manual one,
// while this hook runs. Only the file the command names is this run's.
func TestRunBeforeHook_RecordsOnlyTheNamedFile(t *testing.T) {
	r := newHookRig(t, 10)
	r.changes.files = []string{"packages/db/drizzle/0007_x.sql"}
	const file = "production-abc1234-20260101T000000Z.dump"
	others := []string{"staging-abc1234-20260101T000000Z.dump", file + ".partial", "x" + file}
	write := r.exec.write
	r.exec.write = func(argv []string) error {
		for _, name := range others {
			if err := writeAt(filepath.Join(r.dir, name), hookNow); err != nil {
				return err
			}
		}
		return write(argv)
	}
	if _, err := RunBeforeHook(context.Background(), r.sc, r.deps, "app:abc1234", "shared"); err != nil {
		t.Fatalf("RunBeforeHook: %v\n%s", err, r.log.String())
	}
	var got []string
	for _, b := range r.backups(t) {
		got = append(got, filepath.Base(b.Path))
	}
	if !slices.Equal(got, []string{file}) || r.sc.Outputs["backup_files"] != file {
		t.Fatalf("recorded = %v, backup_files = %q; want only %s", got, r.sc.Outputs["backup_files"], file)
	}
	for _, name := range others {
		if _, err := os.Stat(filepath.Join(r.dir, name)); err != nil {
			t.Errorf("%s: %v, want left alone", name, err)
		}
		if !strings.Contains(r.log.String(), name) {
			t.Errorf("log does not mention the ignored %s:\n%s", name, r.log.String())
		}
	}
}

func TestNamedIn(t *testing.T) {
	const cmd = `pg_dump -f /backup/prod.dump "$URL" && cp /backup/prod.dump x.dump.gz`
	for name, want := range map[string]bool{
		"prod.dump":   true,
		"x.dump.gz":   true,
		"x.dump":      false,
		"od.dump":     false,
		"prod.dump.1": false,
		"backup":      true,
		"dump":        false,
	} {
		if got := namedIn(cmd, name); got != want {
			t.Errorf("namedIn(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestRunBeforeHook_DefaultImageNoNetworkNoEnvFile(t *testing.T) {
	r := newHookRig(t, 10)
	if err := r.store.SetDeployState(context.Background(), store.DeployState{Repo: "acme/web", Env: "production"}); err != nil {
		t.Fatal(err)
	}
	r.sc.Cfg.EnvFile = nil
	r.sc.Cfg.Migrate.Before.Image = nil
	if _, err := RunBeforeHook(context.Background(), r.sc, r.deps, "app:abc1234", ""); err != nil {
		t.Fatalf("RunBeforeHook: %v", err)
	}
	if r.changes.calls != 0 {
		t.Fatalf("ChangedFiles calls = %d on a first deploy, want 0", r.changes.calls)
	}
	if got := r.sc.Outputs["before_reason"]; got != "first_deploy" {
		t.Fatalf("before_reason = %q, want first_deploy", got)
	}
	argv := strings.Join(r.exec.calls[0][:6], " ")
	if want := "docker run --rm -v " + r.dir + ":/backup app:abc1234"; argv != want {
		t.Fatalf("argv = %q, want %q", argv, want)
	}
}

func TestRunBeforeHook_EnvFileNotRootOwned(t *testing.T) {
	r := newHookRig(t, 10)
	r.changes.files = []string{"packages/db/drizzle/0007_x.sql"}
	stubStat(t, fakeInfo{mode: 0o644, uid: 0})
	_, err := RunBeforeHook(context.Background(), r.sc, r.deps, "app:abc1234", "shared")
	if err == nil || !strings.HasPrefix(err.Error(), "deployments.production.env_file:") {
		t.Fatalf("err = %v, want the env_file ownership error", err)
	}
	if len(r.exec.calls) != 0 {
		t.Fatalf("executor calls = %v, want none", r.exec.calls)
	}
}

func TestRunBeforeHook_Retention(t *testing.T) {
	r := newHookRig(t, 2)
	ctx := context.Background()
	if err := os.MkdirAll(r.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	old := hookNow.Add(-time.Hour)
	var prior []string
	for i, name := range []string{"p1.dump", "p2.dump", "p3.dump"} {
		path := filepath.Join(r.dir, name)
		prior = append(prior, path)
		if err := writeAt(path, old); err != nil {
			t.Fatal(err)
		}
		if err := r.store.InsertMigrateBackup(ctx, store.MigrateBackup{
			Repo: "acme/web", Env: "production", RunID: "old", SHA: "prev", Path: path,
			CreatedAt: old.Add(time.Duration(i) * time.Minute),
		}); err != nil {
			t.Fatal(err)
		}
	}
	unrecorded := filepath.Join(r.dir, "manual.dump")
	if err := writeAt(unrecorded, old); err != nil {
		t.Fatal(err)
	}
	r.changes.files = []string{"packages/db/drizzle/0008_y.sql"}

	if _, err := RunBeforeHook(ctx, r.sc, r.deps, "app:abc1234", "shared"); err != nil {
		t.Fatalf("RunBeforeHook: %v", err)
	}
	var got []string
	for _, b := range r.backups(t) {
		got = append(got, filepath.Base(b.Path))
	}
	if want := []string{"production-abc1234-20260101T000000Z.dump", "p3.dump"}; !slices.Equal(got, want) {
		t.Fatalf("recorded backups = %v, want %v", got, want)
	}
	for _, path := range prior[:2] {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s: stat err = %v, want deleted", path, err)
		}
	}
	for _, path := range []string{prior[2], unrecorded} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("%s: %v, want kept", path, err)
		}
	}
}

// A record left by an earlier output_dir is beyond the reach of retention:
// its file stays, and the record is forgotten instead of logged every run.
func TestRunBeforeHook_RetentionForgetsFilesOutsideDir(t *testing.T) {
	r := newHookRig(t, 1)
	ctx := context.Background()
	outside := filepath.Join(t.TempDir(), "elsewhere.dump")
	if err := writeAt(outside, hookNow.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(r.dir, "gone.dump")
	for _, path := range []string{outside, missing} {
		if err := r.store.InsertMigrateBackup(ctx, store.MigrateBackup{
			Repo: "acme/web", Env: "production", RunID: "old", SHA: "prev", Path: path, CreatedAt: hookNow.Add(-time.Hour),
		}); err != nil {
			t.Fatal(err)
		}
	}
	r.changes.files = []string{"packages/db/drizzle/0008_y.sql"}
	if _, err := RunBeforeHook(ctx, r.sc, r.deps, "app:abc1234", "shared"); err != nil {
		t.Fatalf("RunBeforeHook: %v", err)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("file outside output_dir: %v, want kept", err)
	}
	var got []string
	for _, b := range r.backups(t) {
		got = append(got, b.Path)
	}
	if want := []string{filepath.Join(r.dir, "production-abc1234-20260101T000000Z.dump")}; !slices.Equal(got, want) {
		t.Fatalf("recorded = %v, want only the new backup", got)
	}
}

func TestRunBeforeHook_NoFileProduced(t *testing.T) {
	r := newHookRig(t, 10)
	r.changes.files = []string{"packages/db/drizzle/0007_x.sql"}
	if err := os.MkdirAll(r.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeAt(filepath.Join(r.dir, "older.dump"), hookNow.Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	r.exec.write = nil
	ran, err := RunBeforeHook(context.Background(), r.sc, r.deps, "app:abc1234", "shared")
	if ran || err == nil || err.Error() != "migrate.before produced no file in "+r.dir {
		t.Fatalf("RunBeforeHook = %v, %v; want the no-file error", ran, err)
	}
	if len(r.backups(t)) != 0 {
		t.Fatal("a hook without a file recorded a backup")
	}
	if _, ok := r.sc.Outputs["before_ran"]; ok {
		t.Fatalf("before_ran = %q, want unset on failure", r.sc.Outputs["before_ran"])
	}
}

func TestRunBeforeHook_CommandFails(t *testing.T) {
	r := newHookRig(t, 10)
	r.changes.files = []string{"packages/db/drizzle/0007_x.sql"}
	r.exec.write = func([]string) error { return errors.New("deploy: step migrate-before: exit code 1") }
	if _, err := RunBeforeHook(context.Background(), r.sc, r.deps, "app:abc1234", "shared"); err == nil ||
		err.Error() != "deploy: step migrate-before: exit code 1" {
		t.Fatalf("err = %v, want the executor error", err)
	}
	if len(r.backups(t)) != 0 {
		t.Fatal("a failed hook recorded a backup")
	}
}
