package cli

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/egress"
	"github.com/KCuppens/zerocideploy/agent/internal/executor"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/netns"
	"github.com/KCuppens/zerocideploy/agent/internal/scheduler"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

type fakeProxy struct{}

func (fakeProxy) Port() int    { return 0 }
func (fakeProxy) Close() error { return nil }

// testDeps run jobs as plain process groups of the test, with no egress
// proxy, no network namespaces and faked recovery host commands.
func testDeps(t *testing.T, wd string) (Deps, *isolation.None) {
	t.Helper()
	iso := &isolation.None{Grace: time.Second, Warn: func(string) {}}
	host := &execx.Fake{}
	host.On("pkill", nil, execx.FakeResponse{Code: 1})
	host.On("docker", nil, execx.FakeResponse{})
	return Deps{
		Globals: Globals{StateDir: filepath.Join(t.TempDir(), "state"), Slots: 2, Isolation: "none"},
		Isolation: func(name string) (isolation.Isolation, []string, error) {
			if name == "systemd" {
				return nil, nil, errors.New("no systemd in tests")
			}
			return iso, nil, nil
		},
		Clock: time.Now,
		Getwd: func() (string, error) { return wd, nil },
		Hooks: executor.Hooks{
			StartProxy: func(context.Context, egress.Options) (executor.Proxy, error) { return fakeProxy{}, nil },
		},
		Host:  host,
		Netns: &netns.Manager{NetnsDir: t.TempDir(), LookPath: func(string) (string, error) { return "", exec.ErrNotFound }},
		After: time.After,
	}, iso
}

func runCmd(ctx context.Context, d Deps, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := cmdRun(ctx, d, args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

// openState opens the store a command left in d's state dir.
func openState(t *testing.T, d Deps) *store.Store {
	t.Helper()
	db, err := store.Open(filepath.Join(d.Globals.StateDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func onlyRun(t *testing.T, db *store.Store) store.Run {
	t.Helper()
	runs, err := db.ListRuns(context.Background(), store.RunFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 {
		t.Fatalf("runs = %+v, want one", runs)
	}
	return runs[0]
}

func jobNamesOf(t *testing.T, db *store.Store, runID string) []string {
	t.Helper()
	jobs, err := db.Jobs(context.Background(), runID)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, j := range jobs {
		names = append(names, j.Name)
	}
	return names
}

func envOf(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestParseGlobalsDefaults(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		args []string
		want Globals
	}{
		{"home", map[string]string{"HOME": "/home/u"}, []string{"run"},
			Globals{StateDir: "/home/u/.local/state/zeroci", Slots: scheduler.DefaultSlots(), Isolation: "auto"}},
		{"xdg", map[string]string{"HOME": "/home/u", "XDG_STATE_HOME": "/xdg"}, []string{"run"},
			Globals{StateDir: "/xdg/zeroci", Slots: scheduler.DefaultSlots(), Isolation: "auto"}},
		{"env", map[string]string{"HOME": "/home/u", "XDG_STATE_HOME": "/xdg", "ZEROCI_STATE_DIR": "/srv/z"}, []string{"run"},
			Globals{StateDir: "/srv/z", Slots: scheduler.DefaultSlots(), Isolation: "auto"}},
		{"flags", map[string]string{"ZEROCI_STATE_DIR": "/srv/z"}, []string{"--state-dir", "/s", "--slots", "3", "--isolation", "none", "-v", "run"},
			Globals{StateDir: "/s", Slots: 3, Isolation: "none", Verbose: true}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fs := flag.NewFlagSet("zeroci", flag.ContinueOnError)
			fs.SetOutput(&bytes.Buffer{})
			g, rest, err := parseGlobals(fs, append(tc.args, "lint"), envOf(tc.env))
			if err != nil {
				t.Fatal(err)
			}
			if g != tc.want {
				t.Errorf("globals = %+v, want %+v", g, tc.want)
			}
			if want := []string{"run", "lint"}; !reflect.DeepEqual(rest, want) {
				t.Errorf("rest = %q, want %q", rest, want)
			}
		})
	}
}

func TestParseGlobalsInvalid(t *testing.T) {
	home := map[string]string{"HOME": "/home/u"}
	cases := []struct {
		name string
		env  map[string]string
		args []string
		want string
	}{
		{"zero slots", home, []string{"--slots", "0", "run"}, "--slots must be at least 1, got 0"},
		{"bad slots", home, []string{"--slots", "many", "run"}, "invalid value"},
		{"bad isolation", home, []string{"--isolation", "docker", "run"}, `--isolation must be auto, systemd or none, got "docker"`},
		{"unknown flag", home, []string{"--nope", "run"}, "not defined"},
		{"no state dir", map[string]string{}, []string{"run"}, "no state directory"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fs := flag.NewFlagSet("zeroci", flag.ContinueOnError)
			fs.SetOutput(&bytes.Buffer{})
			_, _, err := parseGlobals(fs, tc.args, envOf(tc.env))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %v, want it to contain %q", err, tc.want)
			}
		})
	}

	var stdout, stderr bytes.Buffer
	if code := Main([]string{"--slots", "0", "run"}, &stdout, &stderr); code != ExitUsage {
		t.Errorf("Main(--slots 0 run) = %d, want %d", code, ExitUsage)
	}
	if !strings.Contains(stderr.String(), "zeroci: --slots must be at least 1") {
		t.Errorf("stderr = %q", stderr.String())
	}
}

func TestRunNoConfigDetects(t *testing.T) {
	// The detected jobs run npm; a stub on PATH keeps the test hermetic.
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "npm"), []byte("#!/bin/sh\necho \"npm $*\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	wd := commitWorkDir(t, map[string]string{
		"package.json":      `{"scripts": {"lint": "eslint .", "test": "vitest"}}`,
		"package-lock.json": `{}`,
	})
	d, _ := testDeps(t, wd)

	code, stdout, stderr := runCmd(context.Background(), d)
	if code != ExitOK {
		t.Fatalf("exit = %d, want 0\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if !strings.Contains(stdout, "run ") || !strings.Contains(stdout, "success") {
		t.Errorf("stdout lacks the run summary:\n%s", stdout)
	}
	db := openState(t, d)
	run := onlyRun(t, db)
	if run.State != store.RunSuccess || run.Event != "local" || run.Kind != "check" ||
		run.TrustDomain != "trusted:local/app" || run.Repo != "local/app" || len(run.SHA) != 40 {
		t.Errorf("run = %+v", run)
	}
	if got, want := jobNamesOf(t, db, run.ID), []string{"lint", "test"}; !reflect.DeepEqual(got, want) {
		t.Errorf("jobs = %q, want %q", got, want)
	}
}

func TestRunNothingDetected(t *testing.T) {
	cases := map[string]map[string]string{
		"empty repo": {"README.md": "hello\n"},
		// Python detection gives a setup step but no jobs.
		"python setup only": {"requirements.txt": "requests\n"},
	}
	for name, files := range cases {
		t.Run(name, func(t *testing.T) {
			d, _ := testDeps(t, commitWorkDir(t, files))
			code, _, stderr := runCmd(context.Background(), d)
			if code != ExitNoChecks {
				t.Fatalf("exit = %d, want %d\nstderr:\n%s", code, ExitNoChecks, stderr)
			}
			if want := "zeroci: no checks detected. Add a .zeroci.yml or run zeroci init.\n"; !strings.HasSuffix(stderr, want) {
				t.Errorf("stderr = %q, want it to end with %q", stderr, want)
			}
		})
	}
}

func TestRunFailedJobExit1(t *testing.T) {
	wd := commitWorkDir(t, map[string]string{
		".zeroci.yml": "version: 1\nchecks:\n  jobs:\n    test:\n      run: echo boom; exit 3\n",
	})
	d, _ := testDeps(t, wd)

	code, stdout, stderr := runCmd(context.Background(), d)
	if code != ExitRunFailed {
		t.Fatalf("exit = %d, want 1\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if !strings.Contains(stdout, " | boom") {
		t.Errorf("stdout lacks the failed job tail:\n%s", stdout)
	}
	if run := onlyRun(t, openState(t, d)); run.State != store.RunFailed {
		t.Errorf("run state = %s, want failed", run.State)
	}
}

func TestRunSingleJobWithNeeds(t *testing.T) {
	wd := commitWorkDir(t, map[string]string{
		".zeroci.yml": "version: 1\nchecks:\n  jobs:\n" +
			"    build:\n      run: echo build\n" +
			"    lint:\n      run: echo lint\n" +
			"    gen:\n      run: echo gen\n      needs: [build]\n" +
			"    test:\n      run: echo test\n      needs: [gen]\n",
	})
	d, _ := testDeps(t, wd)

	code, stdout, stderr := runCmd(context.Background(), d, "test")
	if code != ExitOK {
		t.Fatalf("exit = %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	db := openState(t, d)
	if got, want := jobNamesOf(t, db, onlyRun(t, db).ID), []string{"build", "gen", "test"}; !reflect.DeepEqual(got, want) {
		t.Errorf("jobs = %q, want %q", got, want)
	}
}

func TestRunUnknownJob(t *testing.T) {
	wd := commitWorkDir(t, map[string]string{
		".zeroci.yml": "version: 1\nchecks:\n  jobs:\n    lint:\n      run: echo lint\n    test:\n      run: echo test\n",
	})
	d, _ := testDeps(t, wd)

	code, _, stderr := runCmd(context.Background(), d, "deploy")
	if code != ExitUsage {
		t.Fatalf("exit = %d, want %d\nstderr:\n%s", code, ExitUsage, stderr)
	}
	if want := `zeroci: unknown job "deploy" (jobs: lint, test)`; !strings.Contains(stderr, want) {
		t.Errorf("stderr = %q, want %q", stderr, want)
	}
	runs, err := openState(t, d).ListRuns(context.Background(), store.RunFilter{})
	if err != nil || len(runs) != 0 {
		t.Errorf("runs = %+v, %v; want none", runs, err)
	}
}

func TestRunRecoversFirst(t *testing.T) {
	wd := commitWorkDir(t, map[string]string{
		".zeroci.yml": "version: 1\nchecks:\n  jobs:\n    test:\n      run: echo ok\n",
	})
	d, _ := testDeps(t, wd)
	if err := os.MkdirAll(d.Globals.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	db, err := store.Open(filepath.Join(d.Globals.StateDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	crashed := store.Run{
		ID: "01HX0000000000000000000000", Repo: "local/other", SHA: "abc", Ref: "HEAD",
		Event: "local", Kind: "check", TrustDomain: "trusted:local/other",
	}
	if err := db.CreateRun(ctx, crashed, []store.Job{{Name: "test"}}); err != nil {
		t.Fatal(err)
	}
	if err := db.Transition(ctx, crashed.ID, []store.RunState{store.RunQueued}, store.RunRunning, ""); err != nil {
		t.Fatal(err)
	}
	db.Close()
	// A failing host command lands in Report.Errors, which run prints. The
	// sweep only acts on this store's runs, so the failure is the container
	// listing, which always runs.
	host := &execx.Fake{}
	host.On("docker", nil, execx.FakeResponse{Err: errors.New("docker exploded")})
	d.Host = host

	code, stdout, stderr := runCmd(ctx, d)
	if code != ExitOK {
		t.Fatalf("exit = %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	got, err := openState(t, d).GetRun(ctx, crashed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != store.RunInterrupted {
		t.Errorf("crashed run state = %s, want interrupted", got.State)
	}
	if !strings.Contains(stderr, "zeroci: warning: recovery: ") || !strings.Contains(stderr, "docker exploded") {
		t.Errorf("stderr lacks the recovery error:\n%s", stderr)
	}
}

func TestRunSIGINTCancels(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "started")
	wd := commitWorkDir(t, map[string]string{
		".zeroci.yml": "version: 1\nchecks:\n  jobs:\n    slow:\n      run: touch " + marker + " && sleep 60\n",
	})
	d, iso := testDeps(t, wd)

	// cmdRun turns SIGINT and SIGTERM into a cancelled ctx.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	type result struct {
		code           int
		stdout, stderr string
	}
	done := make(chan result, 1)
	go func() {
		code, stdout, stderr := runCmd(ctx, d)
		done <- result{code, stdout, stderr}
	}()
	deadline := time.Now().Add(20 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("job never started")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()

	var res result
	select {
	case res = <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("run did not stop after the interrupt")
	}
	if res.code != ExitRunFailed {
		t.Fatalf("exit = %d, want 1\nstdout:\n%s\nstderr:\n%s", res.code, res.stdout, res.stderr)
	}
	if run := onlyRun(t, openState(t, d)); run.State != store.RunCancelled {
		t.Errorf("run state = %s, want cancelled", run.State)
	}
	units, err := iso.ListUnits(context.Background(), "")
	if err != nil || len(units) != 0 {
		t.Errorf("leftover units = %+v, %v", units, err)
	}
}

func TestRunStateDirBusy(t *testing.T) {
	d, _ := testDeps(t, t.TempDir())
	if err := os.MkdirAll(d.Globals.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	unlock, err := lockStateDir(d.Globals.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()

	code, _, stderr := runCmd(context.Background(), d)
	if code != ExitInternal || !strings.Contains(stderr, errStateDirBusy.Error()) {
		t.Errorf("exit = %d, stderr %q; want %d and %q", code, stderr, ExitInternal, errStateDirBusy)
	}
}
