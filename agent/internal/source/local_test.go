package source

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"slices"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/execx"
)

func newFakeLocal(t *testing.T, porcelain string) (*Local, *execx.Fake, *bytes.Buffer) {
	t.Helper()
	f := &execx.Fake{}
	g := Git{Runner: f}
	f.On("git", g.Args("rev-parse", "--show-toplevel"), execx.FakeResponse{Stdout: "/work/my app\n"})
	f.On("git", g.Args("rev-parse", "HEAD"), execx.FakeResponse{Stdout: testSHA + "\n"})
	f.On("git", g.Args("status", "--porcelain"), execx.FakeResponse{Stdout: porcelain})
	f.On("git", nil, execx.FakeResponse{})
	var warn bytes.Buffer
	l := &Local{Git: g, Dir: "/work/my app/sub", Mirrors: NewMirrors(filepath.Join(t.TempDir(), "mirrors"), g), Warn: &warn}
	return l, f, &warn
}

func TestLocalDirtyWarns(t *testing.T) {
	l, _, warn := newFakeLocal(t, " M main.go\n?? new.txt\n")
	co, err := l.Checkout(context.Background(), Request{Ref: "refs/heads/main"}, filepath.Join(t.TempDir(), "src"))
	if err != nil {
		t.Fatal(err)
	}
	if !co.Dirty {
		t.Fatal("Dirty = false, want true")
	}
	want := "warning: working tree has uncommitted changes; hookci runs the committed HEAD 0123456\n"
	if warn.String() != want {
		t.Fatalf("warning = %q, want %q", warn.String(), want)
	}
	if co.SHA != testSHA || co.Ref != "refs/heads/main" {
		t.Fatalf("checkout = %+v", co)
	}
}

func TestLocalCleanCheckoutFlow(t *testing.T) {
	l, f, warn := newFakeLocal(t, "")
	dir := filepath.Join(t.TempDir(), "src")
	co, err := l.Checkout(context.Background(), Request{}, dir)
	if err != nil {
		t.Fatal(err)
	}
	if co.Dirty || warn.Len() != 0 {
		t.Fatalf("clean tree: Dirty=%v warning=%q", co.Dirty, warn.String())
	}
	if co.Dir != dir || co.SHA != testSHA {
		t.Fatalf("checkout = %+v", co)
	}

	g := l.Git
	mirror := filepath.Join(l.Mirrors.Root, "_local__my-app.git")
	want := [][]string{
		g.Args("rev-parse", "--show-toplevel"),
		g.Args("rev-parse", "HEAD"),
		g.Args("status", "--porcelain"),
		g.Args("init", "--quiet", "--bare", mirror),
		g.Args("-C", mirror, "config", "remote.origin.url", "/work/my app"),
		g.Args("-C", mirror, "fetch", "--no-tags", "--no-recurse-submodules", "--prune", "origin", "+"+testSHA+":refs/hookci/"+testSHA),
		g.Args("clone", "--shared", "--no-checkout", mirror, dir),
		g.Args("-C", dir, "checkout", "--detach", "--quiet", testSHA),
	}
	if len(f.Calls) != len(want) {
		t.Fatalf("calls = %d, want %d: %+v", len(f.Calls), len(want), f.Calls)
	}
	for i, c := range f.Calls {
		if !slices.Equal(c.Args, want[i]) {
			t.Errorf("call %d = %q\nwant %q", i, c.Args, want[i])
		}
	}
	if f.Calls[0].Dir != "/work/my app/sub" || f.Calls[1].Dir != "/work/my app" {
		t.Errorf("rev-parse dirs = %q, %q", f.Calls[0].Dir, f.Calls[1].Dir)
	}
	// The mirror is held until the checkout is released.
	if err := l.Mirrors.GC(context.Background(), LocalStorageRepo(co.Repo)); !errors.Is(err, ErrBusy) {
		t.Fatalf("GC before Release = %v, want ErrBusy", err)
	}
	co.Release()
	if err := l.Mirrors.GC(context.Background(), LocalStorageRepo(co.Repo)); err != nil {
		t.Fatalf("GC after Release = %v", err)
	}
}

// A GitHub owner named "local" must not share a mirror with a local repo.
func TestLocalStorageRepoAvoidsGitHubNames(t *testing.T) {
	m := NewMirrors("/state/mirrors", Git{})
	github, err := m.Path("local/x")
	if err != nil {
		t.Fatal(err)
	}
	repo := LocalRepo("/work/x")
	if repo != "local/x" {
		t.Fatalf("LocalRepo = %q, want local/x", repo)
	}
	local, err := m.Path(LocalStorageRepo(repo))
	if err != nil {
		t.Fatal(err)
	}
	if github == local {
		t.Fatalf("GitHub local/x and local x share mirror %s", local)
	}
}

func TestLocalNotGitRepo(t *testing.T) {
	f := &execx.Fake{}
	g := Git{Runner: f}
	f.On("git", nil, execx.FakeResponse{Code: 128, Stderr: "fatal: not a git repository"})
	l := &Local{Git: g, Dir: "/tmp/plain", Mirrors: NewMirrors(t.TempDir(), g)}
	if _, err := l.Checkout(context.Background(), Request{}, t.TempDir()); !errors.Is(err, ErrNotGitRepo) {
		t.Fatalf("err = %v, want ErrNotGitRepo", err)
	}
	if len(f.Calls) != 1 {
		t.Fatalf("calls after failure = %+v", f.Calls)
	}
}
