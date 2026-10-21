package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/store"
)

func TestDefaultStateDirLegacy(t *testing.T) {
	xdg := t.TempDir()
	legacy := filepath.Join(xdg, "zeroci")
	if err := os.Mkdir(legacy, 0o700); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"XDG_STATE_HOME": xdg}

	if got := defaultStateDir(envOf(env)); got != legacy {
		t.Errorf("only legacy xdg dir: %q, want %q", got, legacy)
	}
	if err := os.Mkdir(filepath.Join(xdg, "hookci"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got, want := defaultStateDir(envOf(env)), filepath.Join(xdg, "hookci"); got != want {
		t.Errorf("both xdg dirs: %q, want %q", got, want)
	}

	home := t.TempDir()
	legacyHome := filepath.Join(home, ".local", "state", "zeroci")
	if err := os.MkdirAll(legacyHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if got := defaultStateDir(envOf(map[string]string{"HOME": home})); got != legacyHome {
		t.Errorf("only legacy home dir: %q, want %q", got, legacyHome)
	}
}

func TestDefaultStateDirEnvFallback(t *testing.T) {
	env := map[string]string{"ZEROCI_STATE_DIR": "/old"}
	if got := defaultStateDir(envOf(env)); got != "/old" {
		t.Errorf("ZEROCI_STATE_DIR: %q, want /old", got)
	}
	env["HOOKCI_STATE_DIR"] = "/new"
	if got := defaultStateDir(envOf(env)); got != "/new" {
		t.Errorf("both set: %q, want /new", got)
	}
}

func TestRunLegacyConfig(t *testing.T) {
	cfg := "version: 1\nchecks:\n  jobs:\n    test:\n      run: echo legacy\n"
	wd := commitWorkDir(t, map[string]string{".zeroci.yml": cfg})
	d, _ := testDeps(t, wd)

	code, stdout, stderr := runCmd(context.Background(), d)
	if code != ExitOK {
		t.Fatalf("exit = %d\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if !strings.Contains(stderr, ".zeroci.yml is deprecated, rename it to .hookci.yml\n") {
		t.Errorf("stderr lacks the deprecation warning:\n%s", stderr)
	}
	if run := onlyRun(t, openState(t, d)); run.State != store.RunSuccess {
		t.Errorf("run state = %s, want success", run.State)
	}
}

func TestRunConfigPrecedence(t *testing.T) {
	wd := commitWorkDir(t, map[string]string{
		".hookci.yml": "version: 1\nchecks:\n  jobs:\n    test:\n      run: echo new\n",
		".zeroci.yml": "version: 1\nchecks:\n  jobs:\n    test:\n      run: exit 3\n",
	})
	d, _ := testDeps(t, wd)

	code, stdout, stderr := runCmd(context.Background(), d)
	if code != ExitOK {
		t.Fatalf("exit = %d, want the .hookci.yml job to run\nstdout:\n%s\nstderr:\n%s", code, stdout, stderr)
	}
	if strings.Contains(stderr, "deprecated") {
		t.Errorf("stderr warns although .hookci.yml exists:\n%s", stderr)
	}
}
