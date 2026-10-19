package executor

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/cache"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/egress"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/netns"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/services"
	"github.com/KCuppens/zerocideploy/agent/internal/source"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// recorder is the shared, ordered list of side effects the fakes saw.
type recorder struct {
	mu    sync.Mutex
	calls []string
}

func (r *recorder) add(s string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, s)
}

func (r *recorder) list() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.calls)
}

// fakeIso records every Spec and runs the job's script func, keyed by job
// name. A job without a func exits 0 with no output.
type fakeIso struct {
	name  string
	rec   *recorder
	jobs  map[string]func(ctx context.Context, s isolation.Spec) (isolation.Result, error)
	units []isolation.Unit

	mu       sync.Mutex
	specs    []isolation.Spec
	prefixes []string
}

func (f *fakeIso) Name() string { return f.name }

func (f *fakeIso) Run(ctx context.Context, s isolation.Spec) (isolation.Result, error) {
	f.mu.Lock()
	f.specs = append(f.specs, s)
	fn := f.jobs[s.Job]
	f.mu.Unlock()
	if fn == nil {
		return isolation.Result{}, nil
	}
	return fn(ctx, s)
}

func (f *fakeIso) Stop(_ context.Context, unit string) error {
	f.rec.add("stop " + unit)
	return nil
}

func (f *fakeIso) ListUnits(_ context.Context, prefix string) ([]isolation.Unit, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prefixes = append(f.prefixes, prefix)
	return f.units, nil
}

func (f *fakeIso) spec(t *testing.T, job string) isolation.Spec {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, s := range f.specs {
		if s.Job == job {
			return s
		}
	}
	t.Fatalf("job %s never ran", job)
	return isolation.Spec{}
}

type fakeSource struct {
	sha      string
	reqs     []source.Request
	released int
}

func (f *fakeSource) Name() string { return "fake" }

func (f *fakeSource) Checkout(_ context.Context, req source.Request, dir string) (source.Checkout, error) {
	f.reqs = append(f.reqs, req)
	return source.Checkout{Dir: dir, SHA: f.sha, Release: func() { f.released++ }}, nil
}

type fakeNetns struct {
	rec       *recorder
	available bool
	setups    []netnsSetup
}

type netnsSetup struct {
	mode    netns.Mode
	port    int
	pidFile string
}

func (f *fakeNetns) Available() (bool, string) {
	if f.available {
		return true, ""
	}
	return false, "pasta not found"
}

func (f *fakeNetns) Setup(_ context.Context, runID string, mode netns.Mode, port int, pidFile string) (*netns.Network, error) {
	f.setups = append(f.setups, netnsSetup{mode, port, pidFile})
	f.rec.add("netns setup")
	name := netns.NSName(runID)
	return &netns.Network{RunID: runID, Mode: mode, NSName: name, NSPath: "/run/netns/" + name, HostProxyPort: port}, nil
}

func (f *fakeNetns) Teardown(_ context.Context, n *netns.Network) error {
	f.rec.add("netns teardown " + n.NSName)
	return nil
}

type fakeProxy struct {
	rec      *recorder
	opts     egress.Options
	closeErr error
	onClose  func()
}

func (p *fakeProxy) Port() int { return 4321 }

func (p *fakeProxy) Close() error {
	if p.onClose != nil {
		p.onClose()
	}
	p.rec.add("proxy close")
	return p.closeErr
}

type fakePostgres struct {
	rec     *recorder
	opts    services.PostgresOptions
	stopErr error
}

func (p *fakePostgres) Env() []string {
	return []string{"DATABASE_URL=postgres://zeroci@localhost/zeroci"}
}

func (p *fakePostgres) Stop(context.Context) error {
	p.rec.add("postgres stop")
	return p.stopErr
}

type fakeCache struct {
	rec      *recorder
	restored []cache.Key
	saved    []cache.Policy
}

func (c *fakeCache) Restore(_ context.Context, k cache.Key, _ string) (bool, func() error, error) {
	c.restored = append(c.restored, k)
	c.rec.add("cache restore")
	return false, func() error { c.rec.add("cache cleanup"); return nil }, nil
}

func (c *fakeCache) Save(_ context.Context, _ cache.Key, p cache.Policy, _ string) error {
	c.saved = append(c.saved, p)
	c.rec.add("cache save")
	return nil
}

// harness is an Executor over fakes, a real store and a temp state dir.
type harness struct {
	ex     *Executor
	st     *store.Store
	state  string
	rec    *recorder
	iso    *fakeIso
	src    *fakeSource
	netns  *fakeNetns
	proxy  *fakeProxy
	pg     *fakePostgres
	cache  *fakeCache
	cfgErr error
}

// newHarness builds the executor; mut may change the options before New.
func newHarness(t *testing.T, isoName string, cfg *config.ResolvedChecks, mut func(*Options)) *harness {
	t.Helper()
	state := t.TempDir()
	st, err := store.Open(filepath.Join(state, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	rec := &recorder{}
	h := &harness{
		st:    st,
		state: state,
		rec:   rec,
		iso:   &fakeIso{name: isoName, rec: rec, jobs: map[string]func(context.Context, isolation.Spec) (isolation.Result, error){}},
		src:   &fakeSource{sha: strings.Repeat("c", 40)},
		netns: &fakeNetns{rec: rec, available: true},
		proxy: &fakeProxy{rec: rec},
		pg:    &fakePostgres{rec: rec},
		cache: &fakeCache{rec: rec},
	}
	o := Options{
		StateDir:  state,
		Store:     st,
		Isolation: h.iso,
		Source:    h.src,
		Config: func(store.Run, string) (*config.ResolvedChecks, error) {
			return cfg, h.cfgErr
		},
		Hooks: Hooks{
			Netns: h.netns,
			StartProxy: func(_ context.Context, o egress.Options) (Proxy, error) {
				h.proxy.opts = o
				rec.add("proxy start")
				return h.proxy, nil
			},
			StartPostgres: func(_ context.Context, o services.PostgresOptions) (Postgres, error) {
				h.pg.opts = o
				rec.add("postgres start")
				return h.pg, nil
			},
			Cache: h.cache,
		},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	if mut != nil {
		mut(&o)
	}
	ex, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	h.ex = ex
	return h
}

// localRun is a trusted `zeroci run` of local/app.
func localRun() store.Run {
	return store.Run{ID: "01run", Repo: "local/app", Ref: "refs/heads/main", Event: "local", Kind: "check", TrustDomain: "trusted:local/app"}
}

// create stores run with one queued job per configured job.
func (h *harness) create(t *testing.T, run store.Run, cfg *config.ResolvedChecks) {
	t.Helper()
	jobs := make([]store.Job, len(cfg.Jobs))
	for i, j := range cfg.Jobs {
		jobs[i] = store.Job{Name: j.Name, Needs: j.Needs}
	}
	if err := h.st.CreateRun(context.Background(), run, jobs); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) runDir(id string) RunDir {
	return RunDir{Root: filepath.Join(h.state, "runs", id)}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// frames decodes every outbox frame of kind into a new T.
func frames[T any](t *testing.T, st *store.Store, kind string) []T {
	t.Helper()
	items, err := st.Pending(context.Background(), 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []T
	for _, it := range items {
		if it.Kind != kind {
			continue
		}
		var v T
		if err := protocol.Unmarshal(it.Payload, &v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	return out
}

// writeOut writes s to the job's stdout as a backend would.
func writeOut(w io.Writer, s string) {
	_, _ = io.WriteString(w, s)
}
