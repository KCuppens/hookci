package gc

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/KCuppens/hookci/agent/internal/cache"
	"github.com/KCuppens/hookci/agent/internal/clock"
	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/store"
)

var start = time.Date(2025, 6, 1, 12, 0, 0, 0, time.UTC)

const (
	stateDir = "/state"
	helpNew  = "Usage:  docker buildx prune\n      --max-used-space bytes   Maximum amount of disk space allowed to keep for cache\n"
	helpOld  = "Usage:  docker builder prune\n      --keep-storage bytes   Amount of disk space to keep for cache\n"
)

// fakeFS serves stateDir from an in-memory tree and records removals.
type fakeFS struct {
	tree    fstest.MapFS
	removed []string
	fail    map[string]error
}

func (f *fakeFS) ReadDir(path string) ([]fs.DirEntry, error) {
	rel, err := filepath.Rel(stateDir, path)
	if err != nil {
		return nil, err
	}
	return f.tree.ReadDir(filepath.ToSlash(rel))
}

func (f *fakeFS) RemoveAll(path string) error {
	if err := f.fail[path]; err != nil {
		return err
	}
	f.removed = append(f.removed, path)
	return nil
}

type harness struct {
	ctx  context.Context
	clk  *clock.Fake
	st   *store.Store
	exec *execx.Fake
	fs   *fakeFS
	envs []RepoEnv
	c    *Collector
	logs bytes.Buffer
}

func newHarness(t *testing.T, envs ...RepoEnv) *harness {
	t.Helper()
	h := &harness{ctx: context.Background(), clk: clock.NewFake(start), exec: &execx.Fake{},
		fs: &fakeFS{tree: fstest.MapFS{}}, envs: envs}
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"), store.WithClock(h.clk.Now))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	h.st = st
	h.c = &Collector{Runner: h.exec, Store: st, StateDir: stateDir, Clock: h.clk, FS: h.fs,
		Repos: func(context.Context) ([]RepoEnv, error) { return h.envs, nil },
		Log:   slog.New(slog.NewTextHandler(&h.logs, nil))}
	h.exec.On("docker", []string{"builder", "prune", "--help"}, execx.FakeResponse{Stdout: helpNew})
	return h
}

// sha returns the commit sha whose image tag is "%07x" of n.
func sha(n int) string { return fmt.Sprintf("%07x", n) + strings.Repeat("0", 33) }

func ref(project string, n int) string { return fmt.Sprintf("%s:%07x", project, n) }

// images makes project's `docker image ls` list images 1..n, image i
// created i hours after start, plus extra raw lines.
func (h *harness) images(project string, n int, extra ...string) {
	var b strings.Builder
	for i := 1; i <= n; i++ {
		fmt.Fprintf(&b, `{"Containers":"N/A","CreatedAt":%q,"ID":"sha256:%064x","Repository":%q,"Tag":"%07x"}`+"\n",
			start.Add(time.Duration(i)*time.Hour).Format(dockerCreatedLayout), i, project, i)
	}
	for _, l := range extra {
		b.WriteString(l + "\n")
	}
	h.exec.On("docker", []string{"image", "ls", "--format", "{{json .}}", "--filter", "reference=" + project + ":*"},
		execx.FakeResponse{Stdout: b.String()})
}

func (h *harness) deployRun(t *testing.T, id, env, state string, n int, finished time.Time) {
	t.Helper()
	r := store.DeployRun{RunID: id, Repo: "acme/web", Env: env, SHA: sha(n), Ref: "refs/heads/main",
		Strategy: "recreate", State: state, CreatedAt: start}
	if !finished.IsZero() {
		r.FinishedAt = finished
	}
	if err := h.st.InsertDeployRun(h.ctx, r); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) plan(t *testing.T) Plan {
	t.Helper()
	p, err := h.c.Plan(h.ctx)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	return p
}

func refs(project string, ns ...int) []string {
	out := []string{}
	for _, n := range ns {
		out = append(out, ref(project, n))
	}
	slices.Sort(out)
	return out
}

func web(retain int) RepoEnv {
	return RepoEnv{Repo: "acme/web", Env: "prod", Project: "web", Retain: retain}
}

func TestPlan_KeepsRetainNewest(t *testing.T) {
	for _, tc := range []struct {
		name   string
		retain int
		want   []int
	}{
		{"retain 5", 5, []int{1, 2, 3}},
		{"zero means 5", 0, []int{1, 2, 3}},
		{"below 2 keeps 2", 1, []int{1, 2, 3, 4, 5, 6}},
		{"more than present", 10, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, web(tc.retain))
			h.images("web", 8,
				`{"CreatedAt":"2020-01-01 00:00:00 +0000 UTC","ID":"sha256:aa","Repository":"web","Tag":"latest"}`,
				`{"CreatedAt":"2020-01-01 00:00:00 +0000 UTC","ID":"sha256:bb","Repository":"web","Tag":"<none>"}`)
			if got, want := h.plan(t).RemoveImages, refs("web", tc.want...); !slices.Equal(got, want) {
				t.Errorf("RemoveImages = %v, want %v", got, want)
			}
		})
	}
}

func TestPlan_NeverRemovesActiveAndPrevious(t *testing.T) {
	h := newHarness(t, web(2))
	h.images("web", 8)
	// Images 1 and 2 are the oldest but the two latest successful deploys;
	// image 3 succeeded before them and is no longer protected.
	h.deployRun(t, "d3", "prod", store.DeploySuccess, 3, start.Add(time.Hour))
	h.deployRun(t, "d1", "prod", store.DeploySuccess, 1, start.Add(2*time.Hour))
	h.deployRun(t, "d2", "prod", store.DeploySuccess, 2, start.Add(3*time.Hour))
	h.deployRun(t, "d4", "prod", store.DeployFailed, 4, start.Add(4*time.Hour))
	h.deployRun(t, "s5", "staging", store.DeploySuccess, 5, start.Add(5*time.Hour))
	if got, want := h.plan(t).RemoveImages, refs("web", 3, 4, 5, 6); !slices.Equal(got, want) {
		t.Errorf("RemoveImages = %v, want %v", got, want)
	}
}

func TestPlan_KeepsNonTerminalRunImages(t *testing.T) {
	h := newHarness(t, web(2))
	h.images("web", 8)
	h.deployRun(t, "q1", "prod", store.DeployQueued, 1, time.Time{})
	h.deployRun(t, "r2", "prod", store.DeployRunning, 2, time.Time{})
	h.deployRun(t, "v3", "prod", store.DeployVerifying, 3, time.Time{})
	h.deployRun(t, "b4", "prod", store.DeployRollingBack, 4, time.Time{})
	h.deployRun(t, "i5", "prod", store.DeployInterrupted, 5, start)
	if got, want := h.plan(t).RemoveImages, refs("web", 5, 6); !slices.Equal(got, want) {
		t.Errorf("RemoveImages = %v, want %v", got, want)
	}
}

func TestPlan_SkipsLockedEnv(t *testing.T) {
	api := RepoEnv{Repo: "acme/api", Env: "prod", Project: "api", Retain: 5}
	h := newHarness(t, web(5), api)
	h.images("api", 8)
	h.images("web", 8)
	if ok, err := h.st.TryAcquireEnvLock(h.ctx, "acme/web", "prod", "d9", start); err != nil || !ok {
		t.Fatalf("TryAcquireEnvLock = %v, %v", ok, err)
	}
	p := h.plan(t)
	if want := refs("api", 1, 2, 3); !slices.Equal(p.RemoveImages, want) {
		t.Errorf("RemoveImages = %v, want %v", p.RemoveImages, want)
	}
	if want := []string{"acme/web/prod: env lock held"}; !slices.Equal(p.SkippedEnvs, want) {
		t.Errorf("SkippedEnvs = %v, want %v", p.SkippedEnvs, want)
	}
	if h.exec.Called("docker", "image", "ls", "--format", "{{json .}}", "--filter", "reference=web:*") {
		t.Error("listed the images of a locked env")
	}
}

func TestPlan_SharedProjectSkippedWhileAnyEnvLocked(t *testing.T) {
	staging := RepoEnv{Repo: "acme/web", Env: "staging", Project: "web", Retain: 2}
	h := newHarness(t, web(5), staging)
	h.images("web", 8)
	if ok, err := h.st.TryAcquireEnvLock(h.ctx, "acme/web", "staging", "s9", start); err != nil || !ok {
		t.Fatalf("TryAcquireEnvLock = %v, %v", ok, err)
	}
	p := h.plan(t)
	if len(p.RemoveImages) != 0 {
		t.Errorf("RemoveImages = %v, want none while staging holds its lock", p.RemoveImages)
	}
	if want := []string{"acme/web/staging: env lock held"}; !slices.Equal(p.SkippedEnvs, want) {
		t.Errorf("SkippedEnvs = %v, want %v", p.SkippedEnvs, want)
	}
}

func TestPlan_PruneFlagFallback(t *testing.T) {
	for _, tc := range []struct {
		name      string
		help      string
		gc        *config.AgentConfigGc
		wantFlag  string
		wantBytes int64
	}{
		{"max-used-space", helpNew, nil, FlagMaxUsedSpace, 10737418240},
		{"keep-storage", helpOld, nil, FlagKeepStorage, 10737418240},
		{"configured cap", helpOld, &config.AgentConfigGc{BuildCacheMaxBytes: 1 << 20}, FlagKeepStorage, 1 << 20},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, web(5))
			h.exec = &execx.Fake{}
			h.c.Runner = h.exec
			h.c.Cfg.Gc = tc.gc
			h.exec.On("docker", []string{"builder", "prune", "--help"}, execx.FakeResponse{Stdout: tc.help})
			h.images("web", 1)
			p := h.plan(t)
			if !p.PruneBuildCache || p.PruneFlag != tc.wantFlag || p.KeepStorageBytes != tc.wantBytes {
				t.Errorf("prune = %v %s %d, want true %s %d", p.PruneBuildCache, p.PruneFlag, p.KeepStorageBytes, tc.wantFlag, tc.wantBytes)
			}
		})
	}
	t.Run("probe fails", func(t *testing.T) {
		h := newHarness(t, web(5))
		h.exec = &execx.Fake{}
		h.c.Runner = h.exec
		h.exec.On("docker", []string{"builder", "prune", "--help"}, execx.FakeResponse{Code: 1, Stderr: "no docker"})
		h.images("web", 1)
		if _, err := h.c.Plan(h.ctx); err == nil {
			t.Error("Plan succeeded with a failing docker probe")
		}
	})
	t.Run("no deploy envs", func(t *testing.T) {
		h := newHarness(t)
		if p := h.plan(t); p.PruneBuildCache || len(h.exec.Calls) != 0 {
			t.Errorf("PruneBuildCache = %v, calls = %v, want no docker work without deploy envs", p.PruneBuildCache, h.exec.Calls)
		}
	})
}

func TestPlan_RunDirs(t *testing.T) {
	h := newHarness(t)
	for i, id := range []string{"ci-old", "ci-new", "ci-running", "ci-queued"} {
		if err := h.st.CreateRun(h.ctx, store.Run{ID: id, Repo: "acme/web", SHA: sha(i + 1), Ref: "refs/heads/main",
			Event: "push", Kind: "check", TrustDomain: "trusted:acme/web"}, nil); err != nil {
			t.Fatal(err)
		}
	}
	finish := func(id string) {
		for _, step := range [][2]store.RunState{{store.RunQueued, store.RunRunning}, {store.RunRunning, store.RunSuccess}} {
			if err := h.st.Transition(h.ctx, id, []store.RunState{step[0]}, step[1], ""); err != nil {
				t.Fatal(err)
			}
		}
	}
	finish("ci-old")
	if err := h.st.Transition(h.ctx, "ci-running", []store.RunState{store.RunQueued}, store.RunRunning, ""); err != nil {
		t.Fatal(err)
	}
	h.deployRun(t, "dep-old", "prod", store.DeploySuccess, 1, start)
	h.clk.Advance(23 * time.Hour)
	finish("ci-new")
	h.deployRun(t, "dep-new", "prod", store.DeployFailed, 2, h.clk.Now())
	h.clk.Advance(2 * time.Hour)
	for _, id := range []string{"ci-old", "ci-new", "ci-running", "ci-queued", "dep-old", "dep-new", "unknown"} {
		h.fs.tree["runs/"+id+"/logs/build.log"] = &fstest.MapFile{}
	}
	h.fs.tree["runs/stray-file"] = &fstest.MapFile{}

	want := []string{"/state/runs/ci-old", "/state/runs/dep-old"}
	if got := h.plan(t).RemoveRunDirs; !slices.Equal(got, want) {
		t.Errorf("RemoveRunDirs = %v, want %v", got, want)
	}
}

func TestPlan_DeployWorkDirs(t *testing.T) {
	h := newHarness(t)
	for id, state := range map[string]string{
		"success": store.DeploySuccess, "failed": store.DeployFailed,
		"superseded": store.DeploySuperseded, "interrupted": store.DeployInterrupted,
	} {
		h.deployRun(t, id, "prod", state, 1, start)
	}
	for id, state := range map[string]string{
		"queued": store.DeployQueued, "running": store.DeployRunning,
		"verifying": store.DeployVerifying, "rollingback": store.DeployRollingBack,
	} {
		h.deployRun(t, id, "prod", state, 1, time.Time{})
	}
	for _, id := range []string{"success", "failed", "superseded", "interrupted", "queued", "running", "verifying", "rollingback"} {
		h.fs.tree["deploy-work/"+id] = &fstest.MapFile{Mode: fs.ModeDir | 0o755, ModTime: start}
	}
	h.fs.tree["deploy-work/orphan-old"] = &fstest.MapFile{Mode: fs.ModeDir | 0o755, ModTime: start}
	h.fs.tree["deploy-work/orphan-new"] = &fstest.MapFile{Mode: fs.ModeDir | 0o755, ModTime: start.Add(2 * time.Hour)}
	// An interrupted checkout of a finished run goes; one of a running run stays.
	h.fs.tree["deploy-work/failed.partial"] = &fstest.MapFile{Mode: fs.ModeDir | 0o755, ModTime: start}
	h.fs.tree["deploy-work/running.partial"] = &fstest.MapFile{Mode: fs.ModeDir | 0o755, ModTime: start}
	// Finished runs other than the live Success runs are removed right away;
	// orphans only past RunDirMaxAge.
	h.clk.Advance(RunDirMaxAge + time.Hour)

	want := []string{"/state/deploy-work/failed", "/state/deploy-work/failed.partial", "/state/deploy-work/interrupted",
		"/state/deploy-work/orphan-old", "/state/deploy-work/superseded"}
	if got := h.plan(t).RemoveRunDirs; !slices.Equal(got, want) {
		t.Errorf("RemoveRunDirs = %v, want %v", got, want)
	}
}

func TestPlan_DeployWorkKeepsLiveSuccessRuns(t *testing.T) {
	h := newHarness(t)
	for i, id := range []string{"oldest", "previous", "live"} {
		h.deployRun(t, id, "prod", store.DeploySuccess, i+1, start.Add(time.Duration(i)*time.Minute))
		h.fs.tree["deploy-work/"+id] = &fstest.MapFile{Mode: fs.ModeDir | 0o755, ModTime: start}
	}
	h.deployRun(t, "staging-live", "staging", store.DeploySuccess, 4, start)
	h.fs.tree["deploy-work/staging-live"] = &fstest.MapFile{Mode: fs.ModeDir | 0o755, ModTime: start}
	h.fs.tree["deploy-work/live.partial"] = &fstest.MapFile{Mode: fs.ModeDir | 0o755, ModTime: start}
	if got, want := h.plan(t).RemoveRunDirs, []string{"/state/deploy-work/live.partial", "/state/deploy-work/oldest"}; !slices.Equal(got, want) {
		t.Errorf("RemoveRunDirs = %v, want %v", got, want)
	}
}

func TestApply_BestEffort(t *testing.T) {
	h := newHarness(t)
	h.exec.On("docker", []string{"image", "rm", "web:0000002"}, execx.FakeResponse{Code: 1, Stderr: "image is in use"})
	h.exec.On("docker", []string{"image", "rm"}, execx.FakeResponse{})
	h.exec.On("docker", []string{"builder", "prune", "--force"}, execx.FakeResponse{Code: 1, Stderr: "daemon down"})
	h.fs.fail = map[string]error{"/state/runs/a": errors.New("busy")}
	p := Plan{
		RemoveImages:    []string{"web:0000001", "web:0000002", "web:0000003"},
		PruneBuildCache: true, PruneFlag: FlagKeepStorage, KeepStorageBytes: 42,
		RemoveRunDirs: []string{"/state/runs/a", "/state/runs/b"},
	}
	res, err := h.c.Apply(h.ctx, p)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if want := []string{"web:0000001", "web:0000003"}; !slices.Equal(res.RemovedImages, want) {
		t.Errorf("RemovedImages = %v, want %v", res.RemovedImages, want)
	}
	if want := []string{"/state/runs/b"}; !slices.Equal(res.RemovedRunDirs, want) {
		t.Errorf("RemovedRunDirs = %v, want %v", res.RemovedRunDirs, want)
	}
	if len(res.Errors) != 3 ||
		!strings.Contains(res.Errors[0], "web:0000002") ||
		!strings.Contains(res.Errors[1], "prune build cache --keep-storage 42") ||
		!strings.Contains(res.Errors[2], "/state/runs/a") {
		t.Errorf("Errors = %q, want image, prune and run dir failures", res.Errors)
	}
	var got []string
	for _, c := range h.exec.Calls {
		got = append(got, strings.Join(append([]string{c.Name}, c.Args...), " "))
	}
	want := []string{"docker image rm web:0000001", "docker image rm web:0000002", "docker image rm web:0000003",
		"docker builder prune --force --keep-storage 42"}
	if !slices.Equal(got, want) {
		t.Errorf("commands = %q, want %q", got, want)
	}
}

func TestRunBestEffort_LogsRemovalsAndErrors(t *testing.T) {
	h := newHarness(t, web(2))
	h.images("web", 3)
	h.exec.On("docker", []string{"image", "rm"}, execx.FakeResponse{})
	h.exec.On("docker", []string{"builder", "prune", "--force"}, execx.FakeResponse{Code: 1, Stderr: "daemon down"})
	h.fs.tree["deploy-work/x"] = &fstest.MapFile{Mode: fs.ModeDir, ModTime: start}
	h.clk.Advance(RunDirMaxAge + time.Hour)

	h.c.RunBestEffort(h.ctx)
	logs := h.logs.String()
	for _, want := range []string{"gc: 1 images, 1 run dirs, 0 cache entries removed", "level=WARN msg=\"gc: prune build cache"} {
		if !strings.Contains(logs, want) {
			t.Errorf("logs missing %q:\n%s", want, logs)
		}
	}
}

// newCache sets up h.c.Cache in a temp dir and returns the cache root.
func (h *harness) newCache(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "cache")
	c, err := cache.New(cache.Options{Root: root, Mode: cache.ModeCopy, Logger: slog.New(slog.DiscardHandler)})
	if err != nil {
		t.Fatal(err)
	}
	h.c.Cache = c
	return root
}

// saveCacheEntry saves a node_modules of size bytes under a lockfile unique
// to name, sets its last use to at and returns the entry's rel.
func (h *harness) saveCacheEntry(t *testing.T, root, name string, size int, at time.Time) string {
	t.Helper()
	wd := t.TempDir()
	for file, content := range map[string]string{"package-lock.json": name, "node_modules/m.js": strings.Repeat("x", size)} {
		path := filepath.Join(wd, file)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	k, err := cache.ComputeKey("trusted:kcuppens/app", "linux-amd64", wd, []string{"package-lock.json"}, []string{"node_modules"})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.c.Cache.Save(context.Background(), k, cache.Policy{Kind: "check", Event: "push", Protected: true, Trusted: true}, wd); err != nil {
		t.Fatal(err)
	}
	rel := filepath.Join("trusted__kcuppens__app", k.Hash)
	if err := os.Chtimes(filepath.Join(root, rel), at, at); err != nil {
		t.Fatal(err)
	}
	return rel
}

func TestCacheEvictsOldAndLeastRecentlyUsedOverCap(t *testing.T) {
	h := newHarness(t)
	root := h.newCache(t)
	h.c.Cfg = config.AgentConfig{Gc: &config.AgentConfigGc{CacheMaxBytes: 150}}
	newest := h.saveCacheEntry(t, root, "newest", 100, start.Add(-time.Hour))
	overCap := h.saveCacheEntry(t, root, "over cap", 100, start.Add(-2*time.Hour))
	stale := h.saveCacheEntry(t, root, "stale", 10, start.Add(-CacheMaxAge-time.Hour))
	young := h.saveCacheEntry(t, root, "young", 10, start.Add(-CacheMaxAge+time.Hour))

	p, err := h.c.Plan(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{stale, young, overCap}; !slices.Equal(p.RemoveCacheEntries, want) {
		t.Fatalf("RemoveCacheEntries = %q, want %q (least recently used first)", p.RemoveCacheEntries, want)
	}
	res, err := h.c.Apply(h.ctx, p)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(res.RemovedCacheEntries, p.RemoveCacheEntries) || len(res.Errors) != 0 {
		t.Errorf("Result = %+v, want the planned entries removed", res)
	}
	entries, err := h.c.Cache.Entries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Rel != newest {
		t.Errorf("Entries after GC = %+v, want only %s", entries, newest)
	}
}

func TestCacheKeepsEntryInUse(t *testing.T) {
	h := newHarness(t)
	root := h.newCache(t)
	rel := h.saveCacheEntry(t, root, "stale", 10, start.Add(-CacheMaxAge-time.Hour))
	stalePlan, err := h.c.Plan(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(stalePlan.RemoveCacheEntries, []string{rel}) {
		t.Fatalf("RemoveCacheEntries = %q, want %q", stalePlan.RemoveCacheEntries, rel)
	}

	// A job restores the entry between plan and apply.
	wd := t.TempDir()
	if err := os.WriteFile(filepath.Join(wd, "package-lock.json"), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}
	k, err := cache.ComputeKey("trusted:kcuppens/app", "linux-amd64", wd, []string{"package-lock.json"}, []string{"node_modules"})
	if err != nil {
		t.Fatal(err)
	}
	hit, cleanup, err := h.c.Cache.Restore(h.ctx, k, wd)
	if err != nil || !hit {
		t.Fatalf("Restore = %v, %v", hit, err)
	}
	defer cleanup()
	if err := os.Chtimes(filepath.Join(root, rel), start.Add(-CacheMaxAge-time.Hour), start.Add(-CacheMaxAge-time.Hour)); err != nil {
		t.Fatal(err)
	}

	if p, err := h.c.Plan(h.ctx); err != nil || len(p.RemoveCacheEntries) != 0 {
		t.Errorf("Plan while in use = %q, %v; want nothing to remove", p.RemoveCacheEntries, err)
	}
	res, err := h.c.Apply(h.ctx, stalePlan)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.RemovedCacheEntries) != 0 || len(res.Errors) != 0 {
		t.Errorf("Apply while in use = %+v, want the entry kept without an error", res)
	}
	if _, err := os.Stat(filepath.Join(wd, "node_modules", "m.js")); err != nil {
		t.Errorf("restored files gone: %v", err)
	}
}
