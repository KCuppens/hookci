package cache

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// ErrInUse is returned by Remove for an entry a Restore still uses, such as
// the lower dir of an overlay whose cleanup has not run.
var ErrInUse = errors.New("cache: entry in use")

// Entry is one stored cache entry.
type Entry struct {
	Rel     string    // entry dir under the cache root: <trust domain dir>/<hash>
	Bytes   int64     // snapshot size recorded by Save
	LastUse time.Time // entry dir mtime: set by Save, refreshed by Restore
	InUse   bool      // a Restore's cleanup has not finished; Remove refuses it
}

// Entries lists the stored entries, most recently used first. Dirs without a
// readable meta.json are skipped: Save only ever renames complete entries in.
func (c *Cache) Entries() ([]Entry, error) {
	domains, err := os.ReadDir(c.root)
	if err != nil {
		return nil, fmt.Errorf("cache: list entries: %w", err)
	}
	var out []Entry
	for _, d := range domains {
		if !d.IsDir() || d.Name() == ".tmp" {
			continue
		}
		hashes, err := os.ReadDir(filepath.Join(c.root, d.Name()))
		if err != nil {
			return nil, fmt.Errorf("cache: list entries: %w", err)
		}
		for _, h := range hashes {
			if !h.IsDir() {
				continue
			}
			rel := filepath.Join(d.Name(), h.Name())
			entry := filepath.Join(c.root, rel)
			m, err := readMeta(entry)
			if err != nil {
				continue
			}
			info, err := os.Stat(entry)
			if err != nil {
				continue
			}
			c.mu.Lock()
			inUse := c.inUse[rel] > 0
			c.mu.Unlock()
			out = append(out, Entry{Rel: rel, Bytes: m.Bytes, LastUse: info.ModTime(), InUse: inUse})
		}
	}
	slices.SortFunc(out, func(a, b Entry) int { return b.LastUse.Compare(a.LastUse) })
	return out, nil
}

// Remove deletes the entry at rel, as listed by Entries. Under the entry's
// lock it refuses an entry in use with ErrInUse and moves the entry into
// <root>/.tmp, so a concurrent Restore sees either the whole entry or a miss;
// the moved copy is deleted after the lock is released.
func (c *Cache) Remove(rel string) error {
	parts := strings.Split(filepath.ToSlash(rel), "/")
	if len(parts) != 2 || !filepath.IsLocal(rel) || parts[0] == ".tmp" {
		return fmt.Errorf("cache: %q is not an entry", rel)
	}
	tmp, err := c.detach(rel)
	if err != nil || tmp == "" {
		return err
	}
	if err := os.RemoveAll(tmp); err != nil {
		return fmt.Errorf("cache: remove %s: %w", rel, err)
	}
	c.log.Info("cache entry removed", "entry", rel)
	return nil
}

// detach moves the entry at rel into a fresh dir under <root>/.tmp and
// returns that dir, or "" when the entry is already gone.
func (c *Cache) detach(rel string) (string, error) {
	unlock := c.lock(rel)
	defer unlock()
	c.mu.Lock()
	busy := c.inUse[rel] > 0
	c.mu.Unlock()
	if busy {
		return "", fmt.Errorf("%w: %s", ErrInUse, rel)
	}
	entry := filepath.Join(c.root, rel)
	if _, err := os.Lstat(entry); errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	tmp, err := os.MkdirTemp(filepath.Join(c.root, ".tmp"), "evict-")
	if err != nil {
		return "", fmt.Errorf("cache: remove %s: %w", rel, err)
	}
	if err := os.Rename(entry, filepath.Join(tmp, "entry")); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("cache: remove %s: %w", rel, err)
	}
	return tmp, nil
}
