package source

import (
	"context"
	"errors"
	"slices"
	"strings"
	"syscall"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

var wantHardened = []string{
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.fsmonitor=false",
	"-c", "protocol.file.allow=user",
	"-c", "submodule.recurse=false",
	"-c", "credential.helper=",
}

func TestGitArgsHardened(t *testing.T) {
	g := Git{}
	for _, args := range [][]string{
		nil,
		{"status", "--porcelain"},
		{"-C", "/x", "checkout", "--detach", "--quiet", strings.Repeat("a", 40)},
		{"clone", "--shared", "--no-checkout", "/m", "/d"},
	} {
		got := g.Args(args...)
		if !slices.Equal(got[:4], []string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"}) {
			t.Errorf("Args(%q) = %q, want hooksPath and fsmonitor first", args, got)
		}
		if !slices.Equal(got[:len(wantHardened)], wantHardened) || !slices.Equal(got[len(wantHardened):], args) {
			t.Errorf("Args(%q) = %q", args, got)
		}
	}

	// Run sends exactly Args(...) to the runner, with env and credential.
	f := &execx.Fake{}
	f.On("git", nil, execx.FakeResponse{Stdout: "ok"})
	cred := &syscall.Credential{Uid: 1234, Gid: 1234}
	out, err := Git{Runner: f}.Run(context.Background(), "/repo", []string{"A=1"}, cred, "status")
	if err != nil || string(out) != "ok" {
		t.Fatalf("Run = %q, %v", out, err)
	}
	c := f.Calls[0]
	if !slices.Equal(c.Args, g.Args("status")) || c.Dir != "/repo" || !slices.Equal(c.Env, []string{"A=1"}) || c.Credential != cred {
		t.Fatalf("recorded %+v", c)
	}
}

func TestGitRunErrorCarriesTrimmedStderr(t *testing.T) {
	f := &execx.Fake{}
	stderr := strings.Repeat("x", 3000) + "fatal: bad object\n"
	f.On("/usr/bin/git", nil, execx.FakeResponse{Code: 128, Stderr: stderr})
	_, err := Git{Runner: f, Bin: "/usr/bin/git"}.Run(context.Background(), "", nil, nil, "fetch", "origin")
	var exitErr *execx.ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 128 {
		t.Fatalf("err = %v, want wrapped ExitError 128", err)
	}
	msg := err.Error()
	if !strings.HasPrefix(msg, "source: git fetch origin: exit status 128: ") || !strings.HasSuffix(msg, "fatal: bad object") {
		t.Fatalf("err = %.120q...", msg)
	}
	if n := len(msg) - len("source: git fetch origin: exit status 128: "); n != stderrLimit {
		t.Fatalf("stderr part is %d bytes, want %d", n, stderrLimit)
	}
	if f.Calls[0].Name != "/usr/bin/git" {
		t.Fatalf("bin = %q", f.Calls[0].Name)
	}
}

func TestSafeGitEnvMinimal(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "ghs_leak")
	t.Setenv("SSH_AUTH_SOCK", "/tmp/agent.sock")
	t.Setenv("GIT_DIR", "/elsewhere/.git")
	t.Setenv("PATH", "/usr/bin:/bin")

	env := SafeGitEnv("/home/run", "GIT_ASKPASS=/bin/zeroci")
	for _, want := range []string{
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_LFS_SKIP_SMUDGE=1",
		"LANG=C",
		"PATH=/usr/bin:/bin",
		"HOME=/home/run",
		"GIT_ASKPASS=/bin/zeroci",
	} {
		if !slices.Contains(env, want) {
			t.Errorf("env lacks %q: %q", want, env)
		}
	}
	if len(env) != 8 {
		t.Errorf("env has %d entries, want 8: %q", len(env), env)
	}
	for _, kv := range env {
		for _, leak := range []string{"GITHUB_TOKEN", "SSH_AUTH_SOCK", "GIT_DIR", "ghs_leak"} {
			if strings.Contains(kv, leak) {
				t.Errorf("env leaks %q: %q", leak, kv)
			}
		}
	}
}
