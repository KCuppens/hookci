package cache

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// saveEntry saves a node_modules of the given content under a lockfile
// unique to it and returns the key.
func saveEntry(t *testing.T, c *Cache, content string) Key {
	t.Helper()
	wd := t.TempDir()
	writeFile(t, filepath.Join(wd, "package-lock.json"), "lock "+content, 0o644)
	writeFile(t, filepath.Join(wd, "node_modules", "m.js"), content, 0o644)
	k := mustKey(t, trustedApp, wd, "node_modules")
	if err := c.Save(context.Background(), k, pushPolicy, wd); err != nil {
		t.Fatal(err)
	}
	return k
}

func setLastUse(t *testing.T, c *Cache, k Key, at time.Time) {
	t.Helper()
	if err := os.Chtimes(entryDir(t, c, k), at, at); err != nil {
		t.Fatal(err)
	}
}

func TestEntriesMostRecentlyUsedFirst(t *testing.T) {
	c := newCache(t, ModeCopy, nil)
	old, recent := saveEntry(t, c, "old"), saveEntry(t, c, "recent!")
	base := time.Now().Add(-48 * time.Hour).Truncate(time.Second)
	setLastUse(t, c, old, base)
	setLastUse(t, c, recent, base.Add(time.Hour))

	entries, err := c.Entries()
	if err != nil {
		t.Fatal(err)
	}
	want := []Entry{
		{Rel: filepath.Join("trusted__kcuppens__app", recent.Hash), Bytes: int64(len("recent!")), LastUse: base.Add(time.Hour)},
		{Rel: filepath.Join("trusted__kcuppens__app", old.Hash), Bytes: int64(len("old")), LastUse: base},
	}
	if len(entries) != len(want) {
		t.Fatalf("Entries = %+v, want %+v", entries, want)
	}
	for i := range want {
		if e := entries[i]; e.Rel != want[i].Rel || e.Bytes != want[i].Bytes || !e.LastUse.Equal(want[i].LastUse) || e.InUse {
			t.Errorf("Entries[%d] = %+v, want %+v", i, e, want[i])
		}
	}

	// A restore is a use: it moves the entry to the front.
	cleanup := mustRestore(t, c, old, newWorkdir(t, nil))
	defer cleanup()
	entries, err = c.Entries()
	if err != nil {
		t.Fatal(err)
	}
	if entries[0].Rel != want[1].Rel || !entries[0].LastUse.After(base.Add(time.Hour)) || !entries[0].InUse {
		t.Errorf("after restore Entries[0] = %+v, want %s used just now and in use", entries[0], want[1].Rel)
	}
}

func TestRemoveRefusesEntryInUseUntilCleanup(t *testing.T) {
	c := newCache(t, ModeCopy, nil)
	k := saveEntry(t, c, "deps")
	rel := filepath.Join("trusted__kcuppens__app", k.Hash)
	cleanup := mustRestore(t, c, k, newWorkdir(t, nil))

	if err := c.Remove(rel); !errors.Is(err, ErrInUse) {
		t.Fatalf("Remove in use = %v, want ErrInUse", err)
	}
	if _, err := os.Stat(entryDir(t, c, k)); err != nil {
		t.Fatalf("entry in use was touched: %v", err)
	}

	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	if err := c.Remove(rel); err != nil {
		t.Fatalf("Remove after cleanup = %v", err)
	}
	if _, err := os.Stat(entryDir(t, c, k)); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("entry still there: %v", err)
	}
	if left, err := os.ReadDir(filepath.Join(c.root, ".tmp")); err != nil || len(left) != 0 {
		t.Errorf(".tmp = %v, %v; want empty", left, err)
	}
	if hit, _, err := c.Restore(context.Background(), k, newWorkdir(t, nil)); hit || err != nil {
		t.Errorf("Restore after Remove = %v, %v; want a miss", hit, err)
	}
	if err := c.Remove(rel); err != nil {
		t.Errorf("Remove of a gone entry = %v, want nil", err)
	}
}

func TestRemoveRejectsNonEntry(t *testing.T) {
	c := newCache(t, ModeCopy, nil)
	for _, rel := range []string{"trusted__kcuppens__app", "../x/y", ".tmp/save-1", "a/b/c", "/abs/x"} {
		if err := c.Remove(rel); err == nil {
			t.Errorf("Remove(%q) = nil, want an error", rel)
		}
	}
}
