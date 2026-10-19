package cache

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

const (
	trustedApp   = "trusted:kcuppens/app"
	untrustedApp = "untrusted:kcuppens/app"
)

var pushPolicy = Policy{Kind: "check", Event: "push", Protected: true, Trusted: true}

func newCache(t *testing.T, mode Mode, r execx.Runner) *Cache {
	t.Helper()
	c, err := New(Options{Root: filepath.Join(t.TempDir(), "cache"), Mode: mode, Runner: r, Logger: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// newWorkdir returns a workdir holding the lockfile and the given files.
func newWorkdir(t *testing.T, files map[string]string) string {
	t.Helper()
	wd := t.TempDir()
	writeFile(t, filepath.Join(wd, "package-lock.json"), "lock v1", 0o644)
	for name, content := range files {
		writeFile(t, filepath.Join(wd, name), content, 0o644)
	}
	return wd
}

func mustKey(t *testing.T, domain, wd string, paths ...string) Key {
	t.Helper()
	k, err := ComputeKey(domain, "linux-amd64", wd, []string{"package-lock.json"}, paths)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func entryDir(t *testing.T, c *Cache, k Key) string {
	t.Helper()
	rel, err := k.entryRel()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(c.root, rel)
}

func mustRestore(t *testing.T, c *Cache, k Key, wd string) func() error {
	t.Helper()
	hit, cleanup, err := c.Restore(context.Background(), k, wd)
	if err != nil || !hit {
		t.Fatalf("Restore = %v, %v", hit, err)
	}
	return cleanup
}

func TestMaySave(t *testing.T) {
	for _, c := range []struct {
		name string
		p    Policy
		want bool
	}{
		{"local", Policy{Kind: "check", Event: "local"}, true},
		{"trusted protected push check", pushPolicy, true},
		{"pull request", Policy{Kind: "check", Event: "pull_request", Protected: true, Trusted: true}, false},
		{"unprotected push", Policy{Kind: "check", Event: "push", Trusted: true}, false},
		{"untrusted push", Policy{Kind: "check", Event: "push", Protected: true}, false},
		{"deploy", Policy{Kind: "deploy", Event: "push", Protected: true, Trusted: true}, false},
	} {
		if got := MaySave(c.p); got != c.want {
			t.Errorf("%s: MaySave = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestSaveRestoreCopyMode(t *testing.T) {
	c := newCache(t, ModeCopy, nil)
	src := newWorkdir(t, nil)
	nm := filepath.Join(src, "node_modules")
	writeFile(t, filepath.Join(nm, "left-pad", "index.js"), "module.exports = 1", 0o644)
	writeFile(t, filepath.Join(nm, "left-pad", "lib", "deep", "util.js"), "util", 0o600)
	writeFile(t, filepath.Join(nm, "left-pad", "bin", "cli"), "#!/bin/sh\n", 0o755)
	if err := os.MkdirAll(filepath.Join(nm, ".bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../left-pad/bin/cli", filepath.Join(nm, ".bin", "left-pad")); err != nil {
		t.Fatal(err)
	}
	k := mustKey(t, trustedApp, src, "node_modules")
	if err := c.Save(context.Background(), k, pushPolicy, src); err != nil {
		t.Fatal(err)
	}

	entry := entryDir(t, c, k)
	if want := filepath.Join(c.root, "trusted__kcuppens__app", k.Hash); entry != want {
		t.Errorf("entry = %s, want %s", entry, want)
	}
	if info, err := os.Stat(c.root); err != nil || info.Mode().Perm() != 0o700 {
		t.Errorf("root mode = %v, %v", info, err)
	}
	var m meta
	data, err := os.ReadFile(filepath.Join(entry, "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	if m.Key.Hash != k.Hash || m.Mode != ModeCopy || m.Bytes != int64(len("module.exports = 1util#!/bin/sh\n")) || m.CreatedAt == "" {
		t.Errorf("meta = %+v", m)
	}

	dst := newWorkdir(t, nil)
	cleanup := mustRestore(t, c, k, dst)
	if got, want := treeState(t, filepath.Join(dst, "node_modules")), treeState(t, nm); !maps.Equal(got, want) {
		t.Errorf("restored tree differs:\n got %v\nwant %v", got, want)
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	if err := cleanup(); err != nil {
		t.Fatal("second cleanup:", err)
	}
}

func TestRestoreMiss(t *testing.T) {
	c := newCache(t, ModeCopy, nil)
	wd := newWorkdir(t, nil)
	hit, cleanup, err := c.Restore(context.Background(), mustKey(t, trustedApp, wd, "node_modules"), wd)
	if hit || err != nil || cleanup == nil {
		t.Fatalf("Restore = %v, %v, cleanup nil %v", hit, err, cleanup == nil)
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(wd, "node_modules")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("miss touched the workdir: %v", err)
	}
}

func TestRestoreIsCopyOnWrite(t *testing.T) {
	c := newCache(t, ModeCopy, nil)
	src := newWorkdir(t, map[string]string{"node_modules/a/index.js": "a", "node_modules/b/index.js": "b"})
	k := mustKey(t, trustedApp, src, "node_modules")
	if err := c.Save(context.Background(), k, pushPolicy, src); err != nil {
		t.Fatal(err)
	}
	entry := entryDir(t, c, k)
	before := treeState(t, entry)

	dst := newWorkdir(t, nil)
	cleanup := mustRestore(t, c, k, dst)
	nm := filepath.Join(dst, "node_modules")
	writeFile(t, filepath.Join(nm, "a", "index.js"), "changed", 0o600)
	writeFile(t, filepath.Join(nm, "c", "new.js"), "new", 0o644)
	if err := os.RemoveAll(filepath.Join(nm, "b")); err != nil {
		t.Fatal(err)
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	if after := treeState(t, entry); !maps.Equal(before, after) {
		t.Errorf("entry changed through the workdir:\nbefore %v\n after %v", before, after)
	}
}

func TestSaveNotAllowed(t *testing.T) {
	c := newCache(t, ModeCopy, nil)
	wd := newWorkdir(t, map[string]string{"node_modules/a.js": "a"})
	for _, p := range []Policy{
		{Kind: "check", Event: "pull_request", Protected: true, Trusted: true},
		{Kind: "deploy", Event: "push", Protected: true, Trusted: true},
		{Kind: "check", Event: "push", Protected: false, Trusted: true},
	} {
		if err := c.Save(context.Background(), mustKey(t, trustedApp, wd, "node_modules"), p, wd); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("%+v: Save = %v, want ErrNotAllowed", p, err)
		}
	}
	if err := c.Save(context.Background(), mustKey(t, untrustedApp, wd, "node_modules"), pushPolicy, wd); err == nil {
		t.Error("trusted policy saved into an untrusted key")
	}
	names, err := os.ReadDir(c.root)
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range names {
		if n.Name() != ".tmp" {
			t.Errorf("unexpected %s in cache root", n.Name())
		}
	}
}

func TestSaveAtomicFirstWriterWins(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cache")
	k := Key{}
	var wds []string
	for _, content := range []string{"first", "second"} {
		wd := newWorkdir(t, map[string]string{"node_modules/x.js": content})
		k = mustKey(t, trustedApp, wd, "node_modules")
		wds = append(wds, wd)
	}
	// Two Cache values over one root behave like two processes.
	var caches []*Cache
	for range wds {
		c, err := New(Options{Root: root, Mode: ModeCopy, Logger: slog.New(slog.DiscardHandler)})
		if err != nil {
			t.Fatal(err)
		}
		caches = append(caches, c)
	}
	errs := make([]error, 4)
	var wg sync.WaitGroup
	for i := range errs {
		wg.Go(func() { errs[i] = caches[i%2].Save(context.Background(), k, pushPolicy, wds[i%2]) })
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("save %d: %v", i, err)
		}
	}
	domains, _ := os.ReadDir(filepath.Join(root, "trusted__kcuppens__app"))
	if len(domains) != 1 {
		t.Errorf("entries = %d, want 1", len(domains))
	}
	if left, _ := os.ReadDir(filepath.Join(root, ".tmp")); len(left) != 0 {
		t.Errorf(".tmp leftovers: %v", left)
	}
	data, err := os.ReadFile(filepath.Join(entryDir(t, caches[0], k), "p0", "x.js"))
	if err != nil || (string(data) != "first" && string(data) != "second") {
		t.Errorf("entry content = %q, %v", data, err)
	}
}

func TestTrustDomainsIsolated(t *testing.T) {
	c := newCache(t, ModeCopy, nil)
	wd := newWorkdir(t, map[string]string{"node_modules/x.js": "trusted"})
	if err := c.Save(context.Background(), mustKey(t, trustedApp, wd, "node_modules"), pushPolicy, wd); err != nil {
		t.Fatal(err)
	}
	for _, domain := range []string{untrustedApp, "trusted:kcuppens/other", "untrusted:kcuppens/other"} {
		dst := newWorkdir(t, nil)
		hit, _, err := c.Restore(context.Background(), mustKey(t, domain, dst, "node_modules"), dst)
		if hit || err != nil {
			t.Errorf("%s: Restore = %v, %v, want a miss", domain, hit, err)
		}
	}

	// An untrusted local save lands in its own directory, never the trusted one.
	local := Policy{Kind: "check", Event: "local"}
	uwd := newWorkdir(t, map[string]string{"node_modules/x.js": "untrusted"})
	uk := mustKey(t, untrustedApp, uwd, "node_modules")
	if err := c.Save(context.Background(), uk, local, uwd); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(entryDir(t, c, uk), "untrusted__kcuppens__app") {
		t.Errorf("untrusted entry at %s", entryDir(t, c, uk))
	}
	dst := newWorkdir(t, nil)
	mustRestore(t, c, mustKey(t, trustedApp, dst, "node_modules"), dst)
	if data, _ := os.ReadFile(filepath.Join(dst, "node_modules", "x.js")); string(data) != "trusted" {
		t.Errorf("trusted restore got %q", data)
	}

	// A key whose hash was computed for another domain is refused.
	forged := uk
	forged.TrustDomain = trustedApp
	if _, _, err := c.Restore(context.Background(), forged, dst); err == nil {
		t.Error("forged key accepted")
	}
}

func TestSaveSkipsMissingPath(t *testing.T) {
	c := newCache(t, ModeCopy, nil)
	src := newWorkdir(t, map[string]string{"node_modules/x.js": "x"})
	k := mustKey(t, trustedApp, src, "node_modules", ".venv", "missing/parent/dir")
	if err := c.Save(context.Background(), k, pushPolicy, src); err != nil {
		t.Fatal(err)
	}
	m, err := readMeta(entryDir(t, c, k))
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{".venv", "missing/parent/dir"}; !slices.Equal(m.Absent, want) {
		t.Errorf("absent = %v, want %v", m.Absent, want)
	}
	dst := newWorkdir(t, nil)
	mustRestore(t, c, k, dst)
	if _, err := os.Stat(filepath.Join(dst, "node_modules", "x.js")); err != nil {
		t.Error(err)
	}
	for _, p := range []string{".venv", "missing"} {
		if _, err := os.Lstat(filepath.Join(dst, p)); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%s created: %v", p, err)
		}
	}
}

func TestReflinkModeUsesCp(t *testing.T) {
	fake := &execx.Fake{}
	cpReal := execx.FakeResponse{Fn: func(c execx.Cmd) error {
		return copyTree(c.Args[len(c.Args)-2], c.Args[len(c.Args)-1])
	}}
	fake.On("cp", []string{"-a", "--reflink=auto"}, cpReal)
	fake.On("cp", []string{"-a", "--reflink=always"}, cpReal)
	c := newCache(t, ModeReflink, fake)
	src := newWorkdir(t, map[string]string{"node_modules/x.js": "x"})
	k := mustKey(t, trustedApp, src, "node_modules")
	if err := c.Save(context.Background(), k, pushPolicy, src); err != nil {
		t.Fatal(err)
	}
	if !fake.Called("cp", "-a", "--reflink=auto", filepath.Join(src, "node_modules")) {
		t.Errorf("save calls = %v", fake.Calls)
	}

	dst := newWorkdir(t, nil)
	// An empty target dir is replaced, so cp does not nest the copy inside it.
	if err := os.Mkdir(filepath.Join(dst, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	fake.Calls = nil
	mustRestore(t, c, k, dst)
	want := []string{"-a", "--reflink=always", filepath.Join(entryDir(t, c, k), "p0"), filepath.Join(dst, "node_modules")}
	if len(fake.Calls) != 1 || !slices.Equal(fake.Calls[0].Args, want) {
		t.Errorf("restore calls = %v, want cp %v", fake.Calls, want)
	}
	if data, _ := os.ReadFile(filepath.Join(dst, "node_modules", "x.js")); string(data) != "x" {
		t.Errorf("restored x.js = %q", data)
	}
}

func TestRestoreRejectsSymlinkedParent(t *testing.T) {
	c := newCache(t, ModeCopy, nil)
	src := newWorkdir(t, map[string]string{"packages/web/node_modules/x.js": "x"})
	k := mustKey(t, trustedApp, src, "packages/web/node_modules")
	if err := c.Save(context.Background(), k, pushPolicy, src); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	dst := newWorkdir(t, nil)
	if err := os.Symlink(outside, filepath.Join(dst, "packages")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Restore(context.Background(), k, dst); !errors.Is(err, ErrBadPath) {
		t.Fatalf("Restore = %v, want ErrBadPath", err)
	}
	if names, _ := os.ReadDir(outside); len(names) != 0 {
		t.Errorf("restore wrote outside the workdir: %v", names)
	}

	// A symlinked target is refused as well.
	dst2 := newWorkdir(t, nil)
	if err := os.MkdirAll(filepath.Join(dst2, "packages", "web"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dst2, "packages", "web", "node_modules")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Restore(context.Background(), k, dst2); !errors.Is(err, ErrBadPath) {
		t.Fatalf("Restore = %v, want ErrBadPath", err)
	}

	// Save refuses to read through a symlinked parent.
	evil := newWorkdir(t, nil)
	writeFile(t, filepath.Join(outside, "web", "node_modules", "secret"), "host", 0o600)
	if err := os.Symlink(outside, filepath.Join(evil, "packages")); err != nil {
		t.Fatal(err)
	}
	ek := mustKey(t, untrustedApp, evil, "packages/web/node_modules")
	if err := c.Save(context.Background(), ek, Policy{Event: "local"}, evil); !errors.Is(err, ErrBadPath) {
		t.Fatalf("Save = %v, want ErrBadPath", err)
	}
}

func TestRestoreKeepsExistingTarget(t *testing.T) {
	c := newCache(t, ModeCopy, nil)
	src := newWorkdir(t, map[string]string{"node_modules/x.js": "cached"})
	k := mustKey(t, trustedApp, src, "node_modules")
	if err := c.Save(context.Background(), k, pushPolicy, src); err != nil {
		t.Fatal(err)
	}
	dst := newWorkdir(t, map[string]string{"node_modules/x.js": "checked in"})
	mustRestore(t, c, k, dst)
	if data, _ := os.ReadFile(filepath.Join(dst, "node_modules", "x.js")); string(data) != "checked in" {
		t.Errorf("x.js = %q", data)
	}
}

func TestOverlayRestoreMounts(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("overlay is linux only")
	}
	fake := &execx.Fake{}
	fake.On("mount", nil, execx.FakeResponse{})
	fake.On("umount", nil, execx.FakeResponse{})
	c := newCache(t, ModeOverlay, fake)
	src := newWorkdir(t, map[string]string{"node_modules/x.js": "x"})
	k := mustKey(t, trustedApp, src, "node_modules")
	if err := c.Save(context.Background(), k, pushPolicy, src); err != nil {
		t.Fatal(err)
	}
	if len(fake.Calls) != 0 {
		t.Errorf("overlay save ran %v, want a plain copy", fake.Calls)
	}

	dst := newWorkdir(t, nil)
	cleanup := mustRestore(t, c, k, dst)
	target := filepath.Join(dst, "node_modules")
	scratch := filepath.Join(dst, ".zeroci-cache", "0")
	opts := "lowerdir=" + filepath.Join(entryDir(t, c, k), "p0") + ",upperdir=" + filepath.Join(scratch, "upper") + ",workdir=" + filepath.Join(scratch, "work")
	if want := []string{"-t", "overlay", "overlay", "-o", opts, target}; len(fake.Calls) != 1 || !slices.Equal(fake.Calls[0].Args, want) {
		t.Errorf("calls = %v, want mount %v", fake.Calls, want)
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	if !fake.Called("umount", target) || len(fake.Calls) != 2 {
		t.Errorf("calls = %v, want one umount", fake.Calls)
	}
	if _, err := os.Lstat(filepath.Join(dst, ".zeroci-cache")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("scratch left: %v", err)
	}
}

func TestOverlayRestoreFailureUndoes(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("overlay is linux only")
	}
	fake := &execx.Fake{}
	fake.On("mount", nil, execx.FakeResponse{Code: 32})
	c := newCache(t, ModeOverlay, fake)
	src := newWorkdir(t, map[string]string{"node_modules/x.js": "x"})
	k := mustKey(t, trustedApp, src, "node_modules")
	if err := c.Save(context.Background(), k, pushPolicy, src); err != nil {
		t.Fatal(err)
	}
	dst := newWorkdir(t, nil)
	if hit, _, err := c.Restore(context.Background(), k, dst); hit || err == nil {
		t.Fatalf("Restore = %v, %v, want an error", hit, err)
	}
	for _, p := range []string{"node_modules", ".zeroci-cache"} {
		if _, err := os.Lstat(filepath.Join(dst, p)); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("%s left after a failed restore: %v", p, err)
		}
	}
}
