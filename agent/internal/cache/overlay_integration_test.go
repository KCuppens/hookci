//go:build integration

package cache

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/testutil"
)

// TestOverlayRestoreIntegration mounts a real overlay: writes in the workdir
// land in the upper dir, the entry stays as saved, and cleanup unmounts.
func TestOverlayRestoreIntegration(t *testing.T) {
	testutil.RequireIntegration(t)
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		t.Skip("overlay mounts need root on linux")
	}
	c, err := New(Options{Root: filepath.Join(t.TempDir(), "cache"), Mode: ModeOverlay, Runner: execx.OS{}, Logger: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	src := t.TempDir()
	writeFile(t, filepath.Join(src, "package-lock.json"), "lock", 0o644)
	writeFile(t, filepath.Join(src, "node_modules", "a", "index.js"), "a", 0o644)
	writeFile(t, filepath.Join(src, "node_modules", "b", "index.js"), "b", 0o644)
	k, err := ComputeKey("trusted:kcuppens/app", "main", runtime.GOOS+"-"+runtime.GOARCH, src, []string{"package-lock.json"}, []string{"node_modules"})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Save(ctx, k, Policy{Kind: "check", Event: "push", Trusted: true}, src); err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(c.root, "trusted__kcuppens__app", k.Hash)
	before := treeState(t, entry)

	dst := t.TempDir()
	hit, cleanup, err := c.Restore(ctx, k, dst)
	if err != nil || !hit {
		t.Fatalf("Restore = %v, %v", hit, err)
	}
	t.Cleanup(func() { _ = cleanup() })
	nm := filepath.Join(dst, "node_modules")
	if data, err := os.ReadFile(filepath.Join(nm, "a", "index.js")); err != nil || string(data) != "a" {
		t.Fatalf("read through overlay = %q, %v", data, err)
	}
	writeFile(t, filepath.Join(nm, "a", "index.js"), "changed", 0o644)
	writeFile(t, filepath.Join(nm, "c", "new.js"), "new", 0o644)
	if err := os.RemoveAll(filepath.Join(nm, "b")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dst, ".hookci-cache", "0", "upper", "c", "new.js")); err != nil {
		t.Errorf("write did not land in upper: %v", err)
	}
	if after := treeState(t, entry); !maps.Equal(before, after) {
		t.Errorf("entry changed through the overlay:\nbefore %v\n after %v", before, after)
	}

	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dst, ".hookci-cache")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("scratch left after cleanup: %v", err)
	}
	if names, err := os.ReadDir(nm); err != nil || len(names) != 0 {
		t.Errorf("node_modules after unmount = %v, %v; want an empty mount point", names, err)
	}
}
