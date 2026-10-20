package cli

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"slices"
	"strings"
	"testing"
)

func TestHubArgv(t *testing.T) {
	for _, tc := range []struct {
		sub, version string
		extra        []string
		want         []string
	}{
		{"upgrade", "v0.4.0", []string{"--yes"}, []string{"npx", "--yes", "zeroci-hub@0.4.0", "upgrade", "--yes"}},
		{"setup", "0.4.0", nil, []string{"npx", "--yes", "zeroci-hub@0.4.0", "setup"}},
		{"setup", "dev", []string{"--dir", "hub"}, []string{"npx", "--yes", "zeroci-hub@latest", "setup", "--dir", "hub"}},
		{"upgrade", "", nil, []string{"npx", "--yes", "zeroci-hub@latest", "upgrade"}},
	} {
		if got := hubArgv(tc.sub, tc.version, tc.extra); !slices.Equal(got, tc.want) {
			t.Errorf("hubArgv(%q, %q, %q) = %q, want %q", tc.sub, tc.version, tc.extra, got, tc.want)
		}
	}
}

// fakeHub records the command zeroci hub runs and answers with err.
type fakeHub struct {
	npx   bool
	err   error
	argv  []string
	stdio Stdio
}

func (f *fakeHub) deps(version string) HubDeps {
	return HubDeps{
		LookPath: func(name string) (string, error) {
			if f.npx && name == "npx" {
				return "/usr/bin/npx", nil
			}
			return "", exec.ErrNotFound
		},
		Run: func(_ context.Context, name string, args []string, stdio Stdio) error {
			f.argv = append([]string{name}, args...)
			f.stdio = stdio
			return f.err
		},
		Version: version,
	}
}

func TestRunHubPassesArgvAndStdioToRun(t *testing.T) {
	f := &fakeHub{npx: true}
	stdio := Stdio{Stdin: strings.NewReader("y\n"), Stdout: &bytes.Buffer{}, Stderr: &bytes.Buffer{}}
	if err := runHub(context.Background(), f.deps("v0.4.0"), "upgrade", []string{"--yes"}, stdio); err != nil {
		t.Fatalf("runHub: %v", err)
	}
	if want := []string{"npx", "--yes", "zeroci-hub@0.4.0", "upgrade", "--yes"}; !slices.Equal(f.argv, want) {
		t.Errorf("argv = %q, want %q", f.argv, want)
	}
	if f.stdio != stdio {
		t.Errorf("Run got stdio %+v, want the caller's %+v", f.stdio, stdio)
	}
}

func TestRunHubReturnsRunError(t *testing.T) {
	boom := errors.New("npx exploded")
	f := &fakeHub{npx: true, err: boom}
	if err := runHub(context.Background(), f.deps("v0.4.0"), "setup", nil, Stdio{}); !errors.Is(err, boom) {
		t.Errorf("runHub error = %v, want %v", err, boom)
	}
}

func TestRunHubWithoutNpx(t *testing.T) {
	f := &fakeHub{}
	err := runHub(context.Background(), f.deps("v0.4.0"), "setup", nil, Stdio{})
	want := "zeroci hub needs Node.js 20+ and npx on this machine (it runs wrangler against your Cloudflare account); install Node or run it from your laptop"
	if err == nil || err.Error() != want {
		t.Errorf("runHub error = %v, want %q", err, want)
	}
	if f.argv != nil {
		t.Errorf("Run called with %q without npx", f.argv)
	}
}

func TestCmdHub(t *testing.T) {
	run := func(f *fakeHub, args ...string) (int, string, string) {
		var stdout, stderr bytes.Buffer
		code := cmdHub(context.Background(), Deps{Hub: f.deps("v0.4.0"), Stdin: strings.NewReader("")}, args, &stdout, &stderr)
		return code, stdout.String(), stderr.String()
	}

	f := &fakeHub{npx: true}
	if code, _, stderr := run(f, "setup", "--dir", "hub", "--org", "acme"); code != ExitOK || stderr != "" {
		t.Errorf("hub setup: exit %d, stderr %q", code, stderr)
	}
	if want := []string{"npx", "--yes", "zeroci-hub@0.4.0", "setup", "--dir", "hub", "--org", "acme"}; !slices.Equal(f.argv, want) {
		t.Errorf("hub setup argv = %q, want %q", f.argv, want)
	}

	if code, _, stderr := run(&fakeHub{}, "upgrade"); code != ExitRunFailed || !strings.Contains(stderr, "needs Node.js 20+ and npx") {
		t.Errorf("hub upgrade without npx: exit %d, stderr %q", code, stderr)
	}

	for _, args := range [][]string{nil, {"render"}} {
		f := &fakeHub{npx: true}
		if code, _, stderr := run(f, args...); code != ExitUsage || !strings.HasPrefix(stderr, "usage: zeroci hub setup|upgrade") || f.argv != nil {
			t.Errorf("hub %q: exit %d, stderr %q, ran %q", args, code, stderr, f.argv)
		}
	}
}

func TestCmdHubReturnsZerociHubExitCode(t *testing.T) {
	failed := exec.Command("sh", "-c", "exit 2").Run()
	f := &fakeHub{npx: true, err: failed}
	var stdout, stderr bytes.Buffer
	if code := cmdHub(context.Background(), Deps{Hub: f.deps("dev")}, []string{"upgrade", "--bogus"}, &stdout, &stderr); code != 2 || stderr.Len() != 0 {
		t.Errorf("exit %d, stderr %q; want 2 and zeroci-hub's own output only", code, stderr.String())
	}
}
