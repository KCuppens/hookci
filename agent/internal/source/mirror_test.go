package source

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

const testSHA = "0123456789abcdef0123456789abcdef01234567"

// argAfterHardened returns the i-th argument after the hardened -c prefix.
func argAfterHardened(c execx.Cmd, i int) string {
	return c.Args[len(wantHardened)+i]
}

func TestEnsureInitsOnceAndSetsRemote(t *testing.T) {
	f := &execx.Fake{}
	f.On("git", nil, execx.FakeResponse{})
	g := Git{Runner: f}
	m := NewMirrors(filepath.Join(t.TempDir(), "mirrors"), g)
	ctx := context.Background()

	path, err := m.Ensure(ctx, "KCuppens/App", "https://github.com/KCuppens/App.git")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(m.Root, "kcuppens__app.git"); path != want {
		t.Fatalf("path = %q, want %q", path, want)
	}
	want := [][]string{
		g.Args("init", "--quiet", "--bare", path),
		g.Args("-C", path, "config", "remote.origin.url", "https://github.com/KCuppens/App.git"),
	}
	if len(f.Calls) != 2 || !slices.Equal(f.Calls[0].Args, want[0]) || !slices.Equal(f.Calls[1].Args, want[1]) {
		t.Fatalf("calls = %+v", f.Calls)
	}

	// An existing mirror is not re-initialised.
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Ensure(ctx, "KCuppens/App", "https://github.com/KCuppens/App.git"); err != nil {
		t.Fatal(err)
	}
	if len(f.Calls) != 3 || !slices.Equal(f.Calls[2].Args, want[1]) {
		t.Fatalf("second Ensure calls = %+v", f.Calls[2:])
	}
}

func TestFetchSerialisedPerRepo(t *testing.T) {
	t.Run("same repo never overlaps", func(t *testing.T) {
		var mu sync.Mutex
		inflight, maxInflight := 0, 0
		f := &execx.Fake{}
		f.On("git", nil, execx.FakeResponse{Fn: func(execx.Cmd) error {
			mu.Lock()
			inflight++
			maxInflight = max(maxInflight, inflight)
			mu.Unlock()
			time.Sleep(2 * time.Millisecond)
			mu.Lock()
			inflight--
			mu.Unlock()
			return nil
		}})
		m := NewMirrors(t.TempDir(), Git{Runner: f})

		var wg sync.WaitGroup
		for range 8 {
			wg.Go(func() {
				// Case variants share a slug, so they share the lock.
				if err := m.Fetch(context.Background(), "owner/Repo", []string{testSHA}, nil); err != nil {
					t.Error(err)
				}
			})
			wg.Go(func() {
				if err := m.Fetch(context.Background(), "OWNER/repo", []string{testSHA}, nil); err != nil {
					t.Error(err)
				}
			})
		}
		wg.Wait()
		if maxInflight != 1 {
			t.Fatalf("max concurrent fetches for one repo = %d, want 1", maxInflight)
		}
		if len(f.Calls) != 16 {
			t.Fatalf("fetches = %d, want 16", len(f.Calls))
		}
	})

	t.Run("different repos overlap", func(t *testing.T) {
		bStarted := make(chan struct{})
		f := &execx.Fake{}
		f.On("git", nil, execx.FakeResponse{Fn: func(c execx.Cmd) error {
			if strings.HasSuffix(argAfterHardened(c, 1), "owner__a.git") {
				select {
				case <-bStarted:
					return nil
				case <-time.After(5 * time.Second):
					return errors.New("fetch of owner/b did not run while owner/a was fetching")
				}
			}
			close(bStarted)
			return nil
		}})
		m := NewMirrors(t.TempDir(), Git{Runner: f})

		errA := make(chan error, 1)
		go func() { errA <- m.Fetch(context.Background(), "owner/a", []string{testSHA}, nil) }()
		for !f.Called("git", wantHardened...) {
			time.Sleep(time.Millisecond)
		}
		if err := m.Fetch(context.Background(), "owner/b", []string{testSHA}, nil); err != nil {
			t.Fatal(err)
		}
		if err := <-errA; err != nil {
			t.Fatal(err)
		}
	})
}

func TestFetchArgv(t *testing.T) {
	f := &execx.Fake{}
	f.On("git", nil, execx.FakeResponse{})
	g := Git{Runner: f}
	m := NewMirrors("/state/mirrors", g)
	refspecs := []string{testSHA, "+refs/pull/12/head:refs/zeroci/pull/12"}
	if err := m.Fetch(context.Background(), "o/r", refspecs, []string{"ZEROCI_ASKPASS=1"}); err != nil {
		t.Fatal(err)
	}
	want := g.Args("-C", "/state/mirrors/o__r.git", "fetch", "--no-tags", "--no-recurse-submodules", "--prune", "origin", testSHA, "+refs/pull/12/head:refs/zeroci/pull/12")
	c := f.Calls[0]
	if !slices.Equal(c.Args, want) {
		t.Fatalf("argv = %q\nwant %q", c.Args, want)
	}
	if !slices.Contains(c.Env, "ZEROCI_ASKPASS=1") || !slices.Contains(c.Env, "GIT_CONFIG_GLOBAL=/dev/null") {
		t.Fatalf("env = %q", c.Env)
	}
	for _, a := range c.Args {
		if strings.Contains(a, "depth") || strings.Contains(a, "shallow") {
			t.Fatalf("fetch must never be shallow: %q", c.Args)
		}
	}
}

func TestFetchRejectsBadSHA(t *testing.T) {
	f := &execx.Fake{}
	f.On("git", nil, execx.FakeResponse{})
	m := NewMirrors(t.TempDir(), Git{Runner: f})
	for _, refspecs := range [][]string{
		nil,
		{"abc123"},
		{strings.ToUpper(testSHA)},
		{testSHA + "0"},
		{"HEAD"},
		{"refs/heads/main"},
		{"+refs/heads/main:refs/heads/main"},
		{"refs/pull/1/head:refs/zeroci/pull/1"},
		{"+refs/pull/1/head:refs/zeroci/../heads/main"},
		{"--upload-pack=touch /tmp/pwned"},
		{testSHA, "main"},
	} {
		err := m.Fetch(context.Background(), "o/r", refspecs, nil)
		if err == nil {
			t.Errorf("Fetch(%q) succeeded, want error", refspecs)
		}
		if len(refspecs) > 0 && !errors.Is(err, ErrBadSHA) {
			t.Errorf("Fetch(%q) = %v, want ErrBadSHA", refspecs, err)
		}
	}
	if len(f.Calls) != 0 {
		t.Fatalf("git was called: %+v", f.Calls)
	}
}

func TestCloneSharedArgv(t *testing.T) {
	f := &execx.Fake{}
	f.On("git", nil, execx.FakeResponse{})
	g := Git{Runner: f}
	m := NewMirrors("/state/mirrors", g)
	dir := filepath.Join(t.TempDir(), "src")
	cred := &syscall.Credential{Uid: 990, Gid: 990}

	release, err := m.CloneShared(context.Background(), "o/r", testSHA, dir, cred)
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	want := [][]string{
		g.Args("clone", "--shared", "--no-checkout", "/state/mirrors/o__r.git", dir),
		g.Args("-C", dir, "checkout", "--detach", "--quiet", testSHA),
	}
	if len(f.Calls) != 2 {
		t.Fatalf("calls = %+v", f.Calls)
	}
	for i, c := range f.Calls {
		if !slices.Equal(c.Args, want[i]) {
			t.Errorf("call %d argv = %q\nwant %q", i, c.Args, want[i])
		}
		if c.Credential != cred {
			t.Errorf("call %d credential = %v, want %v", i, c.Credential, cred)
		}
	}
}

func TestCloneSharedRefusesBadInput(t *testing.T) {
	f := &execx.Fake{}
	f.On("git", nil, execx.FakeResponse{})
	m := NewMirrors(t.TempDir(), Git{Runner: f})

	nonEmpty := t.TempDir()
	if err := os.WriteFile(filepath.Join(nonEmpty, "x"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.CloneShared(context.Background(), "o/r", testSHA, nonEmpty, nil); err == nil || !strings.Contains(err.Error(), "not empty") {
		t.Fatalf("non-empty dir: err = %v", err)
	}
	if _, err := m.CloneShared(context.Background(), "o/r", "main", t.TempDir(), nil); !errors.Is(err, ErrBadSHA) {
		t.Fatalf("bad sha: err = %v", err)
	}
	if len(f.Calls) != 0 {
		t.Fatalf("git was called: %+v", f.Calls)
	}
	// An empty existing dir is accepted.
	release, err := m.CloneShared(context.Background(), "o/r", testSHA, t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	release()
}

func TestGCBusy(t *testing.T) {
	f := &execx.Fake{}
	f.On("git", nil, execx.FakeResponse{})
	g := Git{Runner: f}
	m := NewMirrors("/state/mirrors", g)
	ctx := context.Background()
	gcArgs := g.Args("-C", "/state/mirrors/o__r.git", "gc", "--prune=now", "--auto")

	release, err := m.CloneShared(ctx, "o/r", testSHA, filepath.Join(t.TempDir(), "src"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.GC(ctx, "o/r"); !errors.Is(err, ErrBusy) {
		t.Fatalf("GC with active clone = %v, want ErrBusy", err)
	}
	if f.Called("git", gcArgs...) {
		t.Fatal("gc ran while a clone was active")
	}

	release()
	release() // idempotent: must not drive the counter negative
	if err := m.GC(ctx, "o/r"); err != nil {
		t.Fatalf("GC after release = %v", err)
	}
	if !f.Called("git", gcArgs...) {
		t.Fatal("gc did not run after release")
	}

	release2, err := m.CloneShared(ctx, "o/r", testSHA, filepath.Join(t.TempDir(), "src"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer release2()
	if err := m.GC(ctx, "o/r"); !errors.Is(err, ErrBusy) {
		t.Fatalf("GC with second active clone = %v, want ErrBusy", err)
	}
}

func TestCloneSharedFailureReleases(t *testing.T) {
	f := &execx.Fake{}
	g := Git{Runner: f}
	f.On("git", g.Args("clone"), execx.FakeResponse{Code: 128, Stderr: "fatal: boom"})
	f.On("git", g.Args("-C", "/state/mirrors/o__r.git", "gc"), execx.FakeResponse{})
	m := NewMirrors("/state/mirrors", g)

	if _, err := m.CloneShared(context.Background(), "o/r", testSHA, filepath.Join(t.TempDir(), "src"), nil); err == nil || !strings.Contains(err.Error(), "fatal: boom") {
		t.Fatalf("err = %v", err)
	}
	if err := m.GC(context.Background(), "o/r"); err != nil {
		t.Fatalf("GC after failed clone = %v, want nil", err)
	}
}
