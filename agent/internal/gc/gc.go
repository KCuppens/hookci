// Package gc keeps a deploy host's disk from filling up: it removes old
// "<project>:<sha7>" images beyond each env's retain.images, deletes run dirs
// of finished runs and evicts setup step cache entries by age and total size.
// Only when gc.build_cache_max_bytes is set does it cap the BuildKit cache,
// which is the host's whole default builder cache, shared with every other
// project on the host. Removals are best effort; one failure never stops the
// rest.
package gc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"maps"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/KCuppens/hookci/agent/internal/cache"
	"github.com/KCuppens/hookci/agent/internal/clock"
	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// RunDirMaxAge is how long the dir of a finished run is kept.
const RunDirMaxAge = 24 * time.Hour

// CacheMaxAge is how long a setup step cache entry is kept after its last
// use. gc.cache_max_bytes caps the total size of the younger ones.
const CacheMaxAge = 14 * 24 * time.Hour

// PullCacheMaxAge is how long an entry saved by a pull request (scope
// pull/<n>) is kept after its last use. The pull request may be closed by
// then, and nothing else reads its scope.
const PullCacheMaxAge = 3 * 24 * time.Hour

// Retention defaults of retain.images.
const (
	DefaultRetain = 5
	MinRetain     = 2
)

// liveSuccesses is how many of an env's latest Success runs GC keeps the
// images and the deploy-work checkout of: the live one and the one a
// rollback returns to. A compose app may bind-mount files from its checkout.
const liveSuccesses = 2

// Build cache prune flags, newest first.
const (
	FlagMaxUsedSpace = "--max-used-space"
	FlagKeepStorage  = "--keep-storage"
)

// dockerCreatedLayout is the CreatedAt format of `docker image ls`.
const dockerCreatedLayout = "2006-01-02 15:04:05 -0700 MST"

// sha7Tag matches the "<sha[:7]>" tags deploys give their images.
var sha7Tag = regexp.MustCompile(`^[0-9a-f]{7}$`)

// activeDeployStates are the states of a deploy that may still use its image.
var activeDeployStates = []string{store.DeployQueued, store.DeployRunning, store.DeployVerifying, store.DeployRollingBack}

// Image is one locally stored deploy image.
type Image struct {
	Ref       string // "<project>:<sha7>"
	ID        string
	CreatedAt time.Time
}

// Plan is what one GC pass removes.
type Plan struct {
	RemoveImages       []string `json:"remove_images"` // image refs, sorted
	PruneBuildCache    bool     `json:"prune_build_cache"`
	KeepStorageBytes   int64    `json:"keep_storage_bytes"`
	PruneFlag          string   `json:"prune_flag"`           // FlagMaxUsedSpace or FlagKeepStorage
	RemoveRunDirs      []string `json:"remove_run_dirs"`      // absolute paths, sorted
	RemoveCacheEntries []string `json:"remove_cache_entries"` // under <state>/cache, least recently used first
	SkippedEnvs        []string `json:"skipped_envs"`         // "<repo>/<env>: env lock held"
}

// Result is what one GC pass removed.
type Result struct {
	RemovedImages       []string `json:"removed_images"`
	PrunedBuildCache    bool     `json:"pruned_build_cache"`
	RemovedRunDirs      []string `json:"removed_run_dirs"`
	RemovedCacheEntries []string `json:"removed_cache_entries"`
	Errors              []string `json:"errors"` // one entry per failed removal
}

// Collector plans and applies GC passes. RunBestEffort and HandleControl run
// one pass at a time.
type Collector struct {
	Runner   execx.Runner
	Store    *store.Store
	StateDir string
	Cfg      config.AgentConfig                           // gc.build_cache_max_bytes, gc.cache_max_bytes
	Repos    func(ctx context.Context) ([]RepoEnv, error) // repos and envs with deployments
	Cache    *cache.Cache                                 // the jobs' setup step cache; nil: not evicted
	Clock    clock.Clock                                  // nil: real clock
	FS       FS                                           // nil: the real file system
	Log      *slog.Logger                                 // nil: discard

	pass sync.Mutex
}

// Request is the body of the control op "gc".
type Request struct {
	DryRun bool `json:"dry_run"`
}

// Report is the result of the control op "gc": the plan, and unless DryRun
// what the pass removed.
type Report struct {
	DryRun bool    `json:"dry_run"`
	Plan   Plan    `json:"plan"`
	Result *Result `json:"result,omitempty"`
}

// RepoEnv is one env whose images GC manages.
type RepoEnv struct {
	Repo    string
	Env     string
	Project string // compose.project
	Retain  int    // retain.images, default 5, min 2
}

// Plan works out what a GC pass removes without removing anything.
func (c *Collector) Plan(ctx context.Context) (Plan, error) {
	p := Plan{RemoveImages: []string{}, RemoveRunDirs: []string{}, RemoveCacheEntries: []string{}, SkippedEnvs: []string{}}
	envs, err := c.Repos(ctx)
	if err != nil {
		return Plan{}, fmt.Errorf("gc: list deploy envs: %w", err)
	}
	if len(envs) > 0 {
		if err := c.planImages(ctx, envs, &p); err != nil {
			return Plan{}, err
		}
		if limit := c.buildCacheMaxBytes(); limit > 0 {
			flag, err := c.pruneFlag(ctx)
			if err != nil {
				return Plan{}, err
			}
			p.PruneBuildCache, p.PruneFlag, p.KeepStorageBytes = true, flag, limit
		}
	}
	dirs, err := c.planRunDirs(ctx)
	if err != nil {
		return Plan{}, err
	}
	p.RemoveRunDirs = dirs
	if p.RemoveCacheEntries, err = c.planCache(); err != nil {
		return Plan{}, err
	}
	slices.Sort(p.RemoveImages)
	slices.Sort(p.SkippedEnvs)
	return p, nil
}

// planImages adds to p the images of envs past their retention. Envs that
// share a compose project share its images, so they are judged together:
// the project keeps the largest retain of its envs and every image any of
// them protects, and is left alone while any of their env locks is held.
func (c *Collector) planImages(ctx context.Context, envs []RepoEnv, p *Plan) error {
	active, err := c.Store.ListDeployRunsInStates(ctx, activeDeployStates...)
	if err != nil {
		return fmt.Errorf("gc: %w", err)
	}
	byProject := map[string][]RepoEnv{}
	for _, e := range envs {
		byProject[e.Project] = append(byProject[e.Project], e)
	}
	for _, project := range slices.Sorted(maps.Keys(byProject)) {
		group := byProject[project]
		locked := false
		retain := 0
		protected := map[string]bool{}
		for _, e := range group {
			if _, held, err := c.Store.EnvLockHolder(ctx, e.Repo, e.Env); err != nil {
				return fmt.Errorf("gc: %w", err)
			} else if held {
				p.SkippedEnvs = append(p.SkippedEnvs, e.Repo+"/"+e.Env+": env lock held")
				locked = true
			}
			retain = max(retain, normRetain(e.Retain))
			last, err := c.Store.LastSucceededRuns(ctx, e.Repo, e.Env, liveSuccesses)
			if err != nil {
				return fmt.Errorf("gc: %w", err)
			}
			for _, r := range last {
				protect(protected, project, r.SHA)
			}
			for _, r := range active {
				if r.Repo == e.Repo && r.Env == e.Env {
					protect(protected, project, r.SHA)
				}
			}
		}
		if locked {
			continue
		}
		images, err := c.listImages(ctx, project)
		if err != nil {
			return err
		}
		slices.SortStableFunc(images, func(a, b Image) int {
			if c := b.CreatedAt.Compare(a.CreatedAt); c != 0 {
				return c
			}
			return strings.Compare(a.Ref, b.Ref)
		})
		for i, img := range images {
			if i >= retain && !protected[img.Ref] {
				p.RemoveImages = append(p.RemoveImages, img.Ref)
			}
		}
	}
	return nil
}

// protect marks the image of sha, "<project>:<sha[:7]>", as kept.
func protect(protected map[string]bool, project, sha string) {
	if len(sha) >= 7 {
		protected[project+":"+sha[:7]] = true
	}
}

func normRetain(n int) int {
	if n == 0 {
		return DefaultRetain
	}
	return max(n, MinRetain)
}

// listImages returns the "<project>:<sha7>" images of project.
func (c *Collector) listImages(ctx context.Context, project string) ([]Image, error) {
	var out bytes.Buffer
	if err := c.Runner.Run(ctx, execx.Cmd{Name: "docker",
		Args: []string{"image", "ls", "--format", "{{json .}}", "--filter", "reference=" + project + ":*"}, Stdout: &out}); err != nil {
		return nil, fmt.Errorf("gc: list images of %s: %w", project, err)
	}
	var images []Image
	sc := bufio.NewScanner(&out)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var row struct{ Repository, Tag, ID, CreatedAt string }
		if err := json.Unmarshal(line, &row); err != nil {
			return nil, fmt.Errorf("gc: list images of %s: %w", project, err)
		}
		if row.Repository != project || !sha7Tag.MatchString(row.Tag) {
			continue
		}
		created, err := time.Parse(dockerCreatedLayout, row.CreatedAt)
		if err != nil {
			return nil, fmt.Errorf("gc: image %s:%s created at: %w", row.Repository, row.Tag, err)
		}
		images = append(images, Image{Ref: row.Repository + ":" + row.Tag, ID: row.ID, CreatedAt: created})
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("gc: list images of %s: %w", project, err)
	}
	return images, nil
}

// pruneFlag picks the build cache cap flag this docker understands.
func (c *Collector) pruneFlag(ctx context.Context) (string, error) {
	var out bytes.Buffer
	if err := c.Runner.Run(ctx, execx.Cmd{Name: "docker", Args: []string{"builder", "prune", "--help"}, Stdout: &out, Stderr: &out}); err != nil {
		return "", fmt.Errorf("gc: probe docker builder prune: %w", err)
	}
	if strings.Contains(out.String(), FlagMaxUsedSpace) {
		return FlagMaxUsedSpace, nil
	}
	return FlagKeepStorage, nil
}

func (c *Collector) buildCacheMaxBytes() int64 {
	return int64(c.gcConfig().BuildCacheMaxBytes)
}

// gcConfig is the gc section of Cfg, with the schema defaults when it is absent.
func (c *Collector) gcConfig() *config.AgentConfigGc {
	if c.Cfg.Gc != nil {
		return c.Cfg.Gc
	}
	g := &config.AgentConfigGc{}
	_ = json.Unmarshal([]byte("{}"), g)
	return g
}

// planCache returns the cache entries to evict, least recently used first:
// those unused for longer than CacheMaxAge (PullCacheMaxAge for pull request
// scopes), and, walking branch entries from the most recently used and then
// pull request entries likewise, every entry past the point where the sizes
// sum to more than gc.cache_max_bytes, so a size cap evicts pull request
// entries before any branch's. Entries a job still uses count toward the sum
// but are never evicted.
func (c *Collector) planCache() ([]string, error) {
	remove := []string{}
	if c.Cache == nil {
		return remove, nil
	}
	entries, err := c.Cache.Entries()
	if err != nil {
		return nil, fmt.Errorf("gc: %w", err)
	}
	isPull := func(e cache.Entry) bool { return strings.HasPrefix(e.Scope, "pull/") }
	walk := slices.Clone(entries)
	slices.SortStableFunc(walk, func(a, b cache.Entry) int {
		switch pa, pb := isPull(a), isPull(b); {
		case pa == pb:
			return 0
		case pb:
			return -1
		}
		return 1
	})
	now := c.now()
	limit := int64(c.gcConfig().CacheMaxBytes)
	var total int64
	var evict []cache.Entry
	for _, e := range walk {
		total += e.Bytes
		maxAge := CacheMaxAge
		if isPull(e) {
			maxAge = PullCacheMaxAge
		}
		if !e.InUse && (total > limit || e.LastUse.Before(now.Add(-maxAge))) {
			evict = append(evict, e)
		}
	}
	slices.SortStableFunc(evict, func(a, b cache.Entry) int { return a.LastUse.Compare(b.LastUse) })
	for _, e := range evict {
		remove = append(remove, e.Rel)
	}
	return remove, nil
}

// planRunDirs returns the run dirs to remove: <state>/runs/<id> of check and
// deploy runs that finished more than RunDirMaxAge ago, and
// <state>/deploy-work/<id> (and its in-progress <id>.partial checkout) of
// every finished deploy run plus those without a run older than
// RunDirMaxAge. Dirs of runs still going are kept.
func (c *Collector) planRunDirs(ctx context.Context) ([]string, error) {
	cutoff := c.now().Add(-RunDirMaxAge)
	old, err := c.Store.ListTerminalDeployRunsBefore(ctx, cutoff)
	if err != nil {
		return nil, fmt.Errorf("gc: %w", err)
	}
	oldDeploys := map[string]bool{}
	for _, r := range old {
		oldDeploys[r.RunID] = true
	}
	dirs := []string{}

	root := filepath.Join(c.StateDir, "runs")
	entries, err := c.readDir(root)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		id := e.Name()
		if oldDeploys[id] {
			dirs = append(dirs, filepath.Join(root, id))
			continue
		}
		r, err := c.Store.GetRun(ctx, id)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("gc: %w", err)
		}
		if r.State.Terminal() && r.FinishedAt != nil && r.FinishedAt.Before(cutoff) {
			dirs = append(dirs, filepath.Join(root, id))
		}
	}

	root = filepath.Join(c.StateDir, "deploy-work")
	if entries, err = c.readDir(root); err != nil {
		return nil, err
	}
	live := map[string]map[string]bool{} // "<repo>/<env>" -> run ids of its liveSuccesses
	for _, e := range entries {
		dir := filepath.Join(root, e.Name())
		r, err := c.Store.GetDeployRun(ctx, strings.TrimSuffix(e.Name(), ".partial"))
		switch {
		case errors.Is(err, store.ErrNotFound):
			info, err := e.Info()
			if err != nil {
				return nil, fmt.Errorf("gc: stat %s: %w", dir, err)
			}
			if info.ModTime().Before(cutoff) {
				dirs = append(dirs, dir)
			}
		case err != nil:
			return nil, fmt.Errorf("gc: %w", err)
		case r.Finished():
			key := r.Repo + "/" + r.Env
			if live[key] == nil {
				last, err := c.Store.LastSucceededRuns(ctx, r.Repo, r.Env, liveSuccesses)
				if err != nil {
					return nil, fmt.Errorf("gc: %w", err)
				}
				live[key] = map[string]bool{}
				for _, s := range last {
					live[key][s.RunID] = true
				}
			}
			if !live[key][r.RunID] || strings.HasSuffix(e.Name(), ".partial") {
				dirs = append(dirs, dir)
			}
		}
	}
	slices.Sort(dirs)
	return dirs, nil
}

// readDir lists the dirs in root; a missing root has none.
func (c *Collector) readDir(root string) ([]fs.DirEntry, error) {
	entries, err := c.fs().ReadDir(root)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("gc: read %s: %w", root, err)
	}
	return slices.DeleteFunc(entries, func(e fs.DirEntry) bool { return !e.IsDir() }), nil
}

// Apply removes the images of p one by one, prunes the build cache, then
// removes the run dirs and cache entries. A failed removal is recorded in
// Result.Errors and the rest still run; a cache entry a job took into use
// since the plan is kept. The error is non-nil only when ctx ends first.
func (c *Collector) Apply(ctx context.Context, p Plan) (Result, error) {
	res := Result{RemovedImages: []string{}, RemovedRunDirs: []string{}, RemovedCacheEntries: []string{}, Errors: []string{}}
	for _, ref := range p.RemoveImages {
		if err := ctx.Err(); err != nil {
			return res, fmt.Errorf("gc: %w", err)
		}
		if err := c.Runner.Run(ctx, execx.Cmd{Name: "docker", Args: []string{"image", "rm", ref}}); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("remove image %s: %v", ref, err))
			continue
		}
		res.RemovedImages = append(res.RemovedImages, ref)
	}
	if p.PruneBuildCache {
		if err := ctx.Err(); err != nil {
			return res, fmt.Errorf("gc: %w", err)
		}
		size := strconv.FormatInt(p.KeepStorageBytes, 10)
		if err := c.Runner.Run(ctx, execx.Cmd{Name: "docker", Args: []string{"builder", "prune", "--force", p.PruneFlag, size}}); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("prune build cache %s %s: %v", p.PruneFlag, size, err))
		} else {
			res.PrunedBuildCache = true
		}
	}
	for _, dir := range p.RemoveRunDirs {
		if err := ctx.Err(); err != nil {
			return res, fmt.Errorf("gc: %w", err)
		}
		if err := c.fs().RemoveAll(dir); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("remove run dir %s: %v", dir, err))
			continue
		}
		res.RemovedRunDirs = append(res.RemovedRunDirs, dir)
	}
	for _, rel := range p.RemoveCacheEntries {
		if err := ctx.Err(); err != nil {
			return res, fmt.Errorf("gc: %w", err)
		}
		err := c.Cache.Remove(rel)
		switch {
		case errors.Is(err, cache.ErrInUse):
			c.log().Info("gc: kept cache entry " + rel + ": in use")
		case err != nil:
			res.Errors = append(res.Errors, fmt.Sprintf("remove cache entry %s: %v", rel, err))
		default:
			res.RemovedCacheEntries = append(res.RemovedCacheEntries, rel)
		}
	}
	return res, nil
}

// HandleControl serves the control op "gc": it plans a pass and, unless the
// request is a dry run, applies it.
func (c *Collector) HandleControl(ctx context.Context, body json.RawMessage) (any, error) {
	var req Request
	if len(body) > 0 && string(body) != "null" {
		if err := json.Unmarshal(body, &req); err != nil {
			return nil, fmt.Errorf("gc: bad request: %w", err)
		}
	}
	c.pass.Lock()
	defer c.pass.Unlock()
	p, err := c.Plan(ctx)
	if err != nil {
		return nil, err
	}
	rep := Report{DryRun: req.DryRun, Plan: p}
	if req.DryRun {
		return rep, nil
	}
	res, err := c.Apply(ctx, p)
	if err != nil {
		return nil, err
	}
	c.logResult(res)
	rep.Result = &res
	return rep, nil
}

// RunBestEffort plans and applies one pass, logging what it removed and
// every failure. It never fails its caller.
func (c *Collector) RunBestEffort(ctx context.Context) {
	c.pass.Lock()
	defer c.pass.Unlock()
	log := c.log()
	p, err := c.Plan(ctx)
	if err != nil {
		log.Warn("gc: plan failed", "err", err)
		return
	}
	for _, s := range p.SkippedEnvs {
		log.Info("gc: skipped " + s)
	}
	res, err := c.Apply(ctx, p)
	c.logResult(res)
	if err != nil {
		log.Warn("gc: stopped early", "err", err)
	}
}

func (c *Collector) logResult(res Result) {
	log := c.log()
	log.Info(fmt.Sprintf("gc: %d images, %d run dirs, %d cache entries removed", len(res.RemovedImages), len(res.RemovedRunDirs), len(res.RemovedCacheEntries)))
	for _, e := range res.Errors {
		log.Warn("gc: " + e)
	}
}

func (c *Collector) now() time.Time {
	if c.Clock == nil {
		return time.Now()
	}
	return c.Clock.Now()
}

func (c *Collector) fs() FS {
	if c.FS == nil {
		return osFS{}
	}
	return c.FS
}

func (c *Collector) log() *slog.Logger {
	if c.Log == nil {
		return slog.New(slog.DiscardHandler)
	}
	return c.Log
}
