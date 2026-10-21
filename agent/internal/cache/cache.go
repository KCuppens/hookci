// Package cache keeps copy-on-write snapshots of setup step cache paths
// (node_modules, .venv, ...) per trust domain and restores them into run
// workdirs by reflink, overlay mount or plain copy.
//
// Tool caches such as the eslint --cache file, .tsbuildinfo or .turbo are
// configured as ordinary cache.paths entries and follow the same rules; there
// is no special code for them.
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/KCuppens/hookci/agent/internal/execx"
)

var (
	ErrMiss            = errors.New("cache: miss")
	ErrModeUnsupported = errors.New("cache: mode unsupported on this platform")
	ErrBadPath         = errors.New("cache: path escapes workdir")
	ErrNotAllowed      = errors.New("cache: save not allowed for this run")
)

// scratchDir holds the overlay upper and work dirs inside a workdir.
const scratchDir = ".hookci-cache"

// Policy decides whether a run may write cache entries.
type Policy struct {
	Kind      string // "check" | "deploy"
	Event     string // "push" | "pull_request" | "local"
	Protected bool   // ref matches protected_branches
	Trusted   bool   // run.TrustDomain has the "trusted:" prefix
}

// MaySave reports whether a run under p may write a cache entry: local runs,
// and check runs of trusted pushes to protected branches. PRs, deploys and
// untrusted runs only read.
func MaySave(p Policy) bool {
	return p.Event == "local" || (p.Kind == "check" && p.Event == "push" && p.Protected && p.Trusted)
}

// Options configures New.
type Options struct {
	Root   string // <state>/cache
	Mode   Mode   // "" means DetectMode(Root)
	Runner execx.Runner
	Logger *slog.Logger
	// Chown sets the owner of parent dirs a restore creates; nil: os.Lchown
	// when running as root, else nothing.
	Chown func(path string, uid, gid int) error
}

// Cache stores entries under <Root>/<sanitized trust domain>/<Key.Hash>/.
type Cache struct {
	root   string
	mode   Mode
	runner execx.Runner
	log    *slog.Logger
	chown  func(path string, uid, gid int) error

	mu    sync.Mutex
	locks map[string]*sync.Mutex // per entry, keyed by its path under root
}

// meta is the meta.json of an entry.
type meta struct {
	Key       Key      `json:"key"`
	CreatedAt string   `json:"created_at"` // RFC 3339
	Mode      Mode     `json:"mode"`
	Bytes     int64    `json:"bytes"`
	Absent    []string `json:"absent,omitempty"` // Key.Paths missing at save time
}

// New creates Root with mode 0700 and resolves the mode.
func New(opts Options) (*Cache, error) {
	if opts.Root == "" {
		return nil, errors.New("cache: root is empty")
	}
	root, err := filepath.Abs(opts.Root)
	if err != nil {
		return nil, fmt.Errorf("cache: root: %w", err)
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("cache: create root: %w", err)
	}
	// Entries of trusted repos must stay unreadable to job users.
	if err := os.Chmod(root, 0o700); err != nil {
		return nil, fmt.Errorf("cache: chmod root: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".tmp"), 0o700); err != nil {
		return nil, fmt.Errorf("cache: create tmp: %w", err)
	}
	c := &Cache{root: root, mode: opts.Mode, runner: opts.Runner, log: opts.Logger, chown: opts.Chown, locks: map[string]*sync.Mutex{}}
	if c.runner == nil {
		c.runner = execx.OS{}
	}
	if c.log == nil {
		c.log = slog.Default()
	}
	if c.chown == nil {
		c.chown = lchownAsRoot
	}
	switch {
	case c.mode == "":
		c.mode = detectMode(context.Background(), root, c.runner)
	case !c.mode.valid():
		return nil, fmt.Errorf("cache: unknown mode %q", c.mode)
	}
	return c, nil
}

// Mode reports how Restore materializes entries.
func (c *Cache) Mode() Mode { return c.mode }

// lock serializes Save and Restore on one entry and returns the unlock.
func (c *Cache) lock(rel string) func() {
	c.mu.Lock()
	m, ok := c.locks[rel]
	if !ok {
		m = &sync.Mutex{}
		c.locks[rel] = m
	}
	c.mu.Unlock()
	m.Lock()
	return m.Unlock
}

// Restore materializes the entry for k into workdir. A miss returns
// (false, no-op cleanup, nil). The returned cleanup unmounts overlays and
// removes scratch dirs; it is idempotent. Restore never writes into the
// entry. A target that already holds data is left alone; on error everything
// this call created is removed again.
func (c *Cache) Restore(ctx context.Context, k Key, workdir string) (hit bool, cleanup func() error, err error) {
	noop := func() error { return nil }
	rel, err := k.entryRel()
	if err != nil {
		return false, noop, err
	}
	unlock := c.lock(rel)
	defer unlock()
	entry := filepath.Join(c.root, rel)
	m, err := readMeta(entry)
	if errors.Is(err, ErrMiss) {
		c.log.Debug("cache miss", "trust_domain", k.TrustDomain, "hash", k.Hash)
		return false, noop, nil
	}
	if err != nil {
		return false, noop, err
	}
	if m.Key.Hash != k.Hash {
		return false, noop, fmt.Errorf("cache: entry %s holds key %s", entry, m.Key.Hash)
	}
	r := &restore{c: c, ctx: context.WithoutCancel(ctx), workdir: workdir}
	for i, p := range k.Paths {
		if slices.Contains(m.Absent, p) {
			continue
		}
		if err := r.path(ctx, filepath.Join(entry, "p"+strconv.Itoa(i)), p, i); err != nil {
			return false, noop, errors.Join(err, r.undo())
		}
	}
	c.log.Info("cache restored", "trust_domain", k.TrustDomain, "hash", k.Hash, "mode", c.mode)
	return true, r.cleanup, nil
}

// restore tracks what one Restore call put into a workdir.
type restore struct {
	c       *Cache
	ctx     context.Context // for cleanup, detached from the caller's cancel
	workdir string

	mu      sync.Mutex
	created []string // targets this call created
	mounts  []string // overlay targets still mounted, relative to workdir
	scratch string   // <workdir>/.hookci-cache once created
}

// path restores entry dir src to workdir/rel.
func (r *restore) path(ctx context.Context, src, rel string, i int) error {
	target := filepath.Join(r.workdir, filepath.FromSlash(rel))
	free, err := prepareTarget(r.workdir, rel, r.c.chown)
	if err != nil {
		return err
	}
	if !free {
		r.c.log.Info("cache target exists, keeping it", "path", rel)
		return nil
	}
	r.created = append(r.created, target)
	switch r.c.mode {
	case ModeReflink:
		return r.c.runner.Run(ctx, execx.Cmd{Name: "cp", Args: []string{"-a", "--reflink=always", src, target}})
	case ModeOverlay:
		info, err := os.Lstat(src)
		if err != nil {
			return err
		}
		if info.IsDir() {
			return r.overlay(ctx, src, target, rel, i, info)
		}
	}
	return copyTree(src, target)
}

// overlay mounts lower at target with a fresh upper/work pair under
// <workdir>/.hookci-cache/<i>/.
func (r *restore) overlay(ctx context.Context, lower, target, rel string, i int, lowerInfo fs.FileInfo) error {
	if r.scratch == "" {
		s := filepath.Join(r.workdir, scratchDir)
		// Mkdir fails on anything already there, a symlink included.
		if err := os.Mkdir(s, 0o700); err != nil {
			return fmt.Errorf("cache: overlay scratch: %w", err)
		}
		r.scratch = s
	}
	base := filepath.Join(r.scratch, strconv.Itoa(i))
	upper, work := filepath.Join(base, "upper"), filepath.Join(base, "work")
	for _, d := range []string{base, upper, work} {
		if err := os.Mkdir(d, 0o700); err != nil {
			return err
		}
	}
	// The merged root takes the upper dir's owner and mode, so mirror the
	// snapshot's root for the job user to keep write access.
	if err := setAttrs(upper, lowerInfo); err != nil {
		return err
	}
	if err := os.Mkdir(target, 0o700); err != nil {
		return err
	}
	if err := mountOverlay(ctx, r.c.runner, lower, upper, work, target); err != nil {
		return err
	}
	r.mounts = append(r.mounts, rel)
	return nil
}

// cleanup unmounts overlays, newest first, and removes the scratch dir once
// nothing is mounted. A failed unmount is kept for the next call.
func (r *restore) cleanup() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for len(r.mounts) > 0 {
		rel := r.mounts[len(r.mounts)-1]
		// The job may have swapped a parent for a symlink; never let that
		// redirect a root umount outside the workdir.
		if err := checkParents(r.workdir, rel); err != nil {
			return err
		}
		if err := unmountOverlay(r.ctx, r.c.runner, filepath.Join(r.workdir, filepath.FromSlash(rel))); err != nil {
			return err
		}
		r.mounts = r.mounts[:len(r.mounts)-1]
	}
	if r.scratch != "" {
		if err := os.RemoveAll(r.scratch); err != nil {
			return fmt.Errorf("cache: remove overlay scratch: %w", err)
		}
		r.scratch = ""
	}
	return nil
}

// undo reverts a failed Restore.
func (r *restore) undo() error {
	if err := r.cleanup(); err != nil {
		return err
	}
	var errs []error
	for _, t := range slices.Backward(r.created) {
		errs = append(errs, os.RemoveAll(t))
	}
	return errors.Join(errs...)
}

// prepareTarget makes the parents of workdir/rel and reports whether the
// target is free for a restore. Missing parents are created with chown to the
// owner of the nearest existing parent, so a dir made inside a checkout the
// job user owns stays writable by it; symlinked parents or targets are
// ErrBadPath, so a restore can never write outside the workdir. An empty dir
// counts as free and is removed; any other existing target is not free.
func prepareTarget(workdir, rel string, chown func(path string, uid, gid int) error) (bool, error) {
	owner, err := os.Stat(workdir)
	if err != nil {
		return false, err
	}
	parts := strings.Split(rel, "/")
	dir := workdir
	for _, part := range parts[:len(parts)-1] {
		dir = filepath.Join(dir, part)
		info, err := os.Lstat(dir)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			if err := os.Mkdir(dir, 0o755); err != nil {
				return false, err
			}
			if err := chownLike(dir, owner, chown); err != nil {
				return false, err
			}
		case err != nil:
			return false, err
		case info.Mode()&fs.ModeSymlink != 0:
			return false, fmt.Errorf("%w: %s crosses symlink %s", ErrBadPath, rel, dir)
		case !info.IsDir():
			return false, fmt.Errorf("cache: %s: %s is not a directory", rel, dir)
		default:
			owner = info
		}
	}
	target := filepath.Join(dir, parts[len(parts)-1])
	info, err := os.Lstat(target)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return true, nil
	case err != nil:
		return false, err
	case info.Mode()&fs.ModeSymlink != 0:
		return false, fmt.Errorf("%w: %s is a symlink", ErrBadPath, rel)
	case info.IsDir():
		empty, err := isEmptyDir(target)
		if err != nil || !empty {
			return false, err
		}
		return true, os.Remove(target)
	}
	return false, nil
}

// checkParents rejects rel when a parent below workdir is not a real dir.
func checkParents(workdir, rel string) error {
	parts := strings.Split(rel, "/")
	dir := workdir
	for _, part := range parts[:len(parts)-1] {
		dir = filepath.Join(dir, part)
		info, err := os.Lstat(dir)
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return fmt.Errorf("%w: %s crosses %s, which is not a directory", ErrBadPath, rel, dir)
		}
	}
	return nil
}

// isEmptyDir reports whether dir has no entries.
func isEmptyDir(dir string) (bool, error) {
	f, err := os.Open(dir)
	if err != nil {
		return false, err
	}
	defer f.Close()
	if _, err := f.Readdirnames(1); err != io.EOF {
		return false, err
	}
	return true, nil
}

// Save snapshots the key's paths from workdir into a new entry. It returns
// ErrNotAllowed when the policy forbids writes. The first writer of an entry
// wins; later saves of the same key return nil without touching it.
func (c *Cache) Save(ctx context.Context, k Key, p Policy, workdir string) error {
	if !MaySave(p) {
		return ErrNotAllowed
	}
	if p.Trusted != strings.HasPrefix(k.TrustDomain, "trusted:") {
		return fmt.Errorf("cache: policy trust does not match trust domain %q", k.TrustDomain)
	}
	rel, err := k.entryRel()
	if err != nil {
		return err
	}
	unlock := c.lock(rel)
	defer unlock()
	entry := filepath.Join(c.root, rel)
	if _, err := os.Lstat(entry); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	tmp, err := os.MkdirTemp(filepath.Join(c.root, ".tmp"), "save-")
	if err != nil {
		return fmt.Errorf("cache: save: %w", err)
	}
	defer os.RemoveAll(tmp)
	m := meta{Key: k, CreatedAt: time.Now().UTC().Format(time.RFC3339), Mode: c.mode}
	for i, p := range k.Paths {
		if err := checkParents(workdir, p); errors.Is(err, fs.ErrNotExist) {
			m.Absent = append(m.Absent, p)
			continue
		} else if err != nil {
			return err
		}
		src := filepath.Join(workdir, filepath.FromSlash(p))
		if _, err := os.Lstat(src); errors.Is(err, fs.ErrNotExist) {
			m.Absent = append(m.Absent, p)
			continue
		} else if err != nil {
			return err
		}
		dst := filepath.Join(tmp, "p"+strconv.Itoa(i))
		if c.mode == ModeReflink {
			err = c.runner.Run(ctx, execx.Cmd{Name: "cp", Args: []string{"-a", "--reflink=auto", src, dst}})
		} else {
			err = copyTree(src, dst)
		}
		if err != nil {
			return fmt.Errorf("cache: save %s: %w", p, err)
		}
		n, err := treeBytes(dst)
		if err != nil {
			return err
		}
		m.Bytes += n
	}
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(tmp, "meta.json"), data, 0o600); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(entry), 0o700); err != nil {
		return err
	}
	if err := os.Rename(tmp, entry); err != nil {
		if _, serr := os.Lstat(entry); serr == nil {
			return nil // another process saved the same key first
		}
		return fmt.Errorf("cache: save: %w", err)
	}
	c.log.Info("cache saved", "trust_domain", k.TrustDomain, "hash", k.Hash, "bytes", m.Bytes, "absent", m.Absent)
	return nil
}

func readMeta(entry string) (meta, error) {
	data, err := os.ReadFile(filepath.Join(entry, "meta.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return meta{}, ErrMiss
	}
	if err != nil {
		return meta{}, err
	}
	var m meta
	if err := json.Unmarshal(data, &m); err != nil {
		return meta{}, fmt.Errorf("cache: %s/meta.json: %w", entry, err)
	}
	return m, nil
}

// treeBytes sums the sizes of the regular files under root.
func treeBytes(root string) (int64, error) {
	var n int64
	err := filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		n += info.Size()
		return nil
	})
	return n, err
}
