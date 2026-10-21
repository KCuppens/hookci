package source

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/execx"
)

// plainGit runs unhardened git in dir with an isolated config, for test setup.
func plainGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(SafeGitEnv(t.TempDir()),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// newRealRepo creates a repo with two commits of app.txt ("one", then "two").
func newRealRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not in PATH")
	}
	repo := filepath.Join(t.TempDir(), "app")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	plainGit(t, repo, "init", "--quiet", "--initial-branch=main")
	for _, content := range []string{"one\n", "two\n"} {
		if err := os.WriteFile(filepath.Join(repo, "app.txt"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		plainGit(t, repo, "add", "app.txt")
		plainGit(t, repo, "commit", "--quiet", "-m", strings.TrimSpace(content))
	}
	return repo
}

func newRealLocal(t *testing.T, dir string) (*Local, *bytes.Buffer) {
	t.Helper()
	g := Git{Runner: execx.OS{}}
	var warn bytes.Buffer
	return &Local{Git: g, Dir: dir, Mirrors: NewMirrors(filepath.Join(t.TempDir(), "mirrors"), g), Warn: &warn}, &warn
}

func evalPath(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestRealGitLocalCheckout(t *testing.T) {
	repo := newRealRepo(t)
	head := plainGit(t, repo, "rev-parse", "HEAD")
	if err := os.WriteFile(filepath.Join(repo, "app.txt"), []byte("uncommitted\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "untracked.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(repo, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}

	l, warn := newRealLocal(t, sub)
	dir := filepath.Join(t.TempDir(), "run", "src")
	co, err := l.Checkout(context.Background(), Request{}, dir)
	if err != nil {
		t.Fatal(err)
	}

	if co.SHA != head {
		t.Fatalf("SHA = %s, want HEAD %s", co.SHA, head)
	}
	if got := plainGit(t, dir, "rev-parse", "HEAD"); got != head {
		t.Fatalf("checkout HEAD = %s, want %s", got, head)
	}
	b, err := os.ReadFile(filepath.Join(dir, "app.txt"))
	if err != nil || string(b) != "two\n" {
		t.Fatalf("app.txt = %q, %v; want committed HEAD content", b, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "untracked.txt")); !os.IsNotExist(err) {
		t.Fatalf("untracked file present in checkout: %v", err)
	}
	if !co.Dirty || !strings.Contains(warn.String(), "hookci runs the committed HEAD "+head[:7]) {
		t.Fatalf("Dirty = %v, warning = %q", co.Dirty, warn.String())
	}

	gitDir := filepath.Join(dir, ".git")
	fi, err := os.Stat(gitDir)
	if err != nil {
		t.Fatal(err)
	}
	if !fi.IsDir() {
		b, err := os.ReadFile(gitDir)
		if err != nil {
			t.Fatal(err)
		}
		gitDir = strings.TrimSpace(strings.TrimPrefix(string(b), "gitdir:"))
	}
	alt, err := os.ReadFile(filepath.Join(gitDir, "objects", "info", "alternates"))
	if err != nil {
		t.Fatal(err)
	}
	mirror, err := l.Mirrors.Path(LocalStorageRepo("local/app"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := evalPath(t, strings.TrimSpace(string(alt))), evalPath(t, filepath.Join(mirror, "objects")); got != want {
		t.Fatalf("alternates = %q, want %q", got, want)
	}

	// The fetched sha is pinned by a ref until the checkout is released.
	if got, want := plainGit(t, mirror, "for-each-ref", "--format=%(refname)", "refs/hookci/"), "refs/hookci/"+head; got != want {
		t.Fatalf("refs before release = %q, want %q", got, want)
	}
	co.Release()
	if got := plainGit(t, mirror, "for-each-ref", "refs/hookci/"); got != "" {
		t.Fatalf("refs after release = %q, want none", got)
	}
}

func TestRealGitHooksIgnored(t *testing.T) {
	repo := newRealRepo(t)
	marker := filepath.Join(t.TempDir(), "hook-ran")
	hook := filepath.Join(repo, ".git", "hooks", "post-checkout")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\ntouch '"+marker+"'\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Control: plain git runs the hook.
	plainGit(t, repo, "checkout", "--quiet", "main")
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("control: hook did not run under plain git: %v", err)
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}

	l, _ := newRealLocal(t, repo)
	if _, err := l.Checkout(context.Background(), Request{}, filepath.Join(t.TempDir(), "src")); err != nil {
		t.Fatal(err)
	}
	// The hardened wrapper ignores the hook even in the repo that holds it.
	if _, err := l.Git.Run(context.Background(), repo, gitEnv(), nil, "checkout", "--quiet", "main"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("post-checkout hook ran: %v", err)
	}
}
