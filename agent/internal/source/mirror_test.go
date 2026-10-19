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

// Jobs must not read other repos' mirrors, so the root is the agent's alone,
// and Ensure tightens a root an older agent left 0755.
func TestEnsureMirrorRootPrivate(t *testing.T) {
	f := &execx.Fake{}
	f.On("git", nil, execx.FakeResponse{})
	root := filepath.Join(t.TempDir(), "mirrors")
	m := NewMirrors(root, Git{Runner: f})
	for _, before := range []os.FileMode{0, 0o755} {
		if before != 0 {
			if err := os.Chmod(root, before); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := m.Ensure(context.Background(), "o/r", "https://github.com/o/r.git"); err != nil {
			t.Fatal(err)
		}
		fi, err := os.Stat(root)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o700 {
			t.Errorf("root mode after Ensure on %o = %o, want 700", before, fi.Mode().Perm())
		}
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
	want := g.Args("-C", "/state/mirrors/o__r.git", "fetch", "--no-tags", "--no-recurse-submodules", "--prune", "origin", "+"+testSHA+":refs/zeroci/"+testSHA, "+refs/pull/12/head:refs/zeroci/pull/12")
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
	const mirror = "/state/mirrors/o__r.git"
	f := &execx.Fake{}
	f.On("git", nil, execx.FakeResponse{})
	g := Git{Runner: f}
	m := NewMirrors("/state/mirrors", g)
	dir := filepath.Join(t.TempDir(), "src")

	release, err := m.CloneShared(context.Background(), "o/r", testSHA, dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	release()
	want := [][]string{
		g.Args("clone", "--shared", "--no-checkout", mirror, dir),
		g.Args("-C", dir, "checkout", "--detach", "--quiet", testSHA),
	}
	if len(f.Calls) != len(want) {
		t.Fatalf("calls = %+v", f.Calls)
	}
	for i, c := range f.Calls {
		if !slices.Equal(c.Args, want[i]) {
			t.Errorf("call %d argv = %q\nwant %q", i, c.Args, want[i])
		}
		if c.Credential != nil {
			t.Errorf("call %d credential = %v, want the agent", i, c.Credential)
		}
	}
}

// A job user's checkout must not need the mirror: the agent clones with
// copied objects, checks out, and hands every file to the job user.
func TestCloneSharedAsJobUserCopiesObjects(t *testing.T) {
	const mirror = "/state/mirrors/o__r.git"
	jobUser := &syscall.Credential{Uid: 990, Gid: 991}
	dir := filepath.Join(t.TempDir(), "src")
	f := &execx.Fake{}
	g := Git{Runner: f}
	f.On("git", g.Args("clone"), execx.FakeResponse{Fn: func(execx.Cmd) error {
		return os.MkdirAll(filepath.Join(dir, ".git", "objects"), 0o755)
	}})
	f.On("git", nil, execx.FakeResponse{Fn: func(execx.Cmd) error {
		return os.WriteFile(filepath.Join(dir, "main.go"), nil, 0o644)
	}})
	m := NewMirrors("/state/mirrors", g)
	var chowned []string
	m.Chown = func(path string, uid, gid int) error {
		if uid != 990 || gid != 991 {
			t.Errorf("chown %s to %d:%d, want 990:991", path, uid, gid)
		}
		chowned = append(chowned, path)
		return nil
	}

	release, err := m.CloneShared(context.Background(), "o/r", testSHA, dir, jobUser)
	if err != nil {
		t.Fatal(err)
	}
	release()
	want := [][]string{
		g.Args("clone", "--no-hardlinks", "--no-checkout", mirror, dir),
		g.Args("-c", "safe.directory="+dir, "-C", dir, "checkout", "--detach", "--quiet", testSHA),
	}
	if len(f.Calls) != len(want) {
		t.Fatalf("calls = %+v", f.Calls)
	}
	for i, c := range f.Calls {
		if !slices.Equal(c.Args, want[i]) {
			t.Errorf("call %d argv = %q\nwant %q", i, c.Args, want[i])
		}
		if c.Credential != nil {
			t.Errorf("call %d ran as %v, want the agent: the job user cannot read the mirror", i, c.Credential)
		}
	}
	wantChown := []string{dir, filepath.Join(dir, ".git"), filepath.Join(dir, ".git", "objects"), filepath.Join(dir, "main.go")}
	if !slices.Equal(chowned, wantChown) {
		t.Errorf("chowned %q, want %q", chowned, wantChown)
	}
}

// A fetched sha stays referenced until its last clone is released, so GC
// between a fetch and its clone, or during a run, cannot prune it.
func TestFetchPinsSHAUntilLastRelease(t *testing.T) {
	f := &execx.Fake{}
	f.On("git", nil, execx.FakeResponse{})
	g := Git{Runner: f}
	m := NewMirrors("/state/mirrors", g)
	ctx := context.Background()
	deleteRef := g.Args("-C", "/state/mirrors/o__r.git", "update-ref", "-d", "refs/zeroci/"+testSHA)
	clone := func() func() {
		t.Helper()
		release, err := m.CloneShared(ctx, "o/r", testSHA, filepath.Join(t.TempDir(), "src"), nil)
		if err != nil {
			t.Fatal(err)
		}
		return release
	}

	if err := m.Fetch(ctx, "o/r", []string{testSHA}, nil); err != nil {
		t.Fatal(err)
	}
	releaseA := clone()
	if err := m.Fetch(ctx, "o/r", []string{testSHA}, nil); err != nil {
		t.Fatal(err)
	}
	releaseA()
	if f.Called("git", deleteRef...) {
		t.Fatal("ref deleted while a fetch still waits for its clone")
	}
	releaseB := clone()
	releaseC := clone()
	releaseB()
	if f.Called("git", deleteRef...) {
		t.Fatal("ref deleted while a clone is live")
	}
	if err := m.GC(ctx, "o/r"); !errors.Is(err, ErrBusy) {
		t.Fatalf("GC with a live clone = %v, want ErrBusy", err)
	}
	releaseC()
	releaseC()
	n := 0
	for _, c := range f.Calls {
		if slices.Equal(c.Args, deleteRef) {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("ref deleted %d times after the last release, want 1", n)
	}
	if err := m.GC(ctx, "o/r"); err != nil {
		t.Fatalf("GC after the last release = %v", err)
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
	if f.Called("git", g.Args("-C", "/state/mirrors/o__r.git", "update-ref")...) {
		t.Fatal("release deleted a ref no Fetch created")
	}
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
