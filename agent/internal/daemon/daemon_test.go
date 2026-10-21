package daemon

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/agentconf"
	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/executor"
	"github.com/KCuppens/hookci/agent/internal/hubclient"
	"github.com/KCuppens/hookci/agent/internal/logpipe"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/scheduler"
	"github.com/KCuppens/hookci/agent/internal/source"
	"github.com/KCuppens/hookci/agent/internal/store"
)

const (
	headSHA = "1111111111111111111111111111111111111111"
	baseSHA = "2222222222222222222222222222222222222222"

	unitOnly    = "version: 1\nchecks:\n  jobs:\n    unit:\n      run: go test ./...\n"
	unitAndLint = "version: 1\nchecks:\n  jobs:\n    unit:\n      run: go test ./...\n    lint:\n      run: golangci-lint run\n"
)

// idleDialer never connects: the tests hand frames to HandleFrame directly.
// Run dials only after settling earlier triggers, so the first Dial closes
// dialed to tell the test the daemon is serving.
type idleDialer struct {
	once   sync.Once
	dialed chan struct{}
}

func (d *idleDialer) Dial(ctx context.Context, _ string, _ http.Header) (hubclient.Conn, error) {
	d.once.Do(func() { close(d.dialed) })
	<-ctx.Done()
	return nil, ctx.Err()
}

// fakeSource writes Head (and Base, when the request has a base) as the
// checked-out trees. With Block set, Checkout waits for ctx.
type fakeSource struct {
	Head, Base map[string]string
	Block      bool
	started    chan struct{}
}

func (f *fakeSource) Name() string { return "fake" }

func (f *fakeSource) Checkout(ctx context.Context, req source.Request, dir string) (source.Checkout, error) {
	close(f.started)
	if f.Block {
		<-ctx.Done()
		return source.Checkout{}, ctx.Err()
	}
	if err := writeTree(dir, f.Head); err != nil {
		return source.Checkout{}, err
	}
	co := source.Checkout{Repo: req.Repo, Dir: dir, SHA: req.SHA, Ref: req.Ref, Release: func() {}}
	if req.BaseSHA != "" {
		co.BaseDir = filepath.Join(filepath.Dir(dir), "base-"+req.RunID)
		if err := writeTree(co.BaseDir, f.Base); err != nil {
			return source.Checkout{}, err
		}
	}
	return co, nil
}

func writeTree(dir string, files map[string]string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			return err
		}
	}
	return nil
}

// fakeRunner records the jobs it runs. With Block set, RunJob waits for ctx
// and reports the job cancelled. With Log set, each job writes it as its log
// file under stateDir's run dir.
type fakeRunner struct {
	Block     bool
	Log       string
	stateDir  string
	mu        sync.Mutex
	jobs      []string
	running   chan string
	cancelled bool
}

func (r *fakeRunner) RunSetup(context.Context, store.Run) error { return nil }

func (r *fakeRunner) RunJob(ctx context.Context, run store.Run, job store.Job) (scheduler.JobOutcome, error) {
	r.mu.Lock()
	r.jobs = append(r.jobs, job.Name)
	r.mu.Unlock()
	r.running <- job.Name
	if r.Log != "" {
		path := logpipe.LogPath(filepath.Join(r.stateDir, "runs", run.ID), job.Name)
		if err := writeTree(filepath.Dir(path), map[string]string{filepath.Base(path): r.Log}); err != nil {
			return scheduler.JobOutcome{}, err
		}
	}
	if !r.Block {
		return scheduler.JobOutcome{State: store.JobSuccess}, nil
	}
	<-ctx.Done()
	r.mu.Lock()
	r.cancelled = true
	r.mu.Unlock()
	return scheduler.JobOutcome{State: store.JobCancelled, Reason: "cancelled"}, nil
}

func (r *fakeRunner) FinishRun(context.Context, store.Run, store.RunState) error { return nil }

type harness struct {
	t        *testing.T
	ctx      context.Context
	st       *store.Store
	d        *Daemon
	runner   *fakeRunner
	src      *fakeSource
	mu       sync.Mutex
	execs    [][]string           // job names of every ExecutorFunc call
	policies []executor.RunPolicy // policy of every ExecutorFunc call
	seq      int
}

func newHarness(t *testing.T, src *fakeSource, runner *fakeRunner) *harness {
	return newHarnessAt(t, src, runner, "https://hub.invalid")
}

// newHarnessAt is newHarness with the hub at hubURL, where job logs go.
func newHarnessAt(t *testing.T, src *fakeSource, runner *fakeRunner, hubURL string) *harness {
	t.Helper()
	stateDir := t.TempDir()
	runner.stateDir = stateDir
	st, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	src.started = make(chan struct{})
	runner.running = make(chan string, 16)
	h := &harness{t: t, st: st, src: src, runner: runner}
	exec := func(_ source.Checkout, checks *config.ResolvedChecks, policy executor.RunPolicy) (scheduler.JobRunner, error) {
		var names []string
		for _, j := range checks.Jobs {
			names = append(names, j.Name)
		}
		h.mu.Lock()
		h.execs = append(h.execs, names)
		h.policies = append(h.policies, policy)
		h.mu.Unlock()
		return runner, nil
	}
	conf := &agentconf.AgentConfig{HubURL: hubURL, AgentID: "agt_1", Credential: "zc_agent_x"}
	dialer := &idleDialer{dialed: make(chan struct{})}
	h.d = New(conf, st, exec, Options{StateDir: stateDir, Dialer: dialer, Source: src, Slots: 2})

	ctx, cancel := context.WithCancel(context.Background())
	h.ctx = ctx
	done := make(chan error, 1)
	go func() { done <- h.d.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != context.Canceled {
			t.Errorf("Run = %v, want context.Canceled", err)
		}
	})
	<-dialer.dialed
	return h
}

func (h *harness) send(f protocol.Frame) {
	h.t.Helper()
	if err := h.d.HandleFrame(h.ctx, f); err != nil {
		h.t.Fatalf("HandleFrame(%T): %v", f, err)
	}
}

func (h *harness) trigger(id string, pr bool) protocol.Trigger {
	h.seq++
	seq := h.seq
	t := protocol.Trigger{
		Attempt: 1, Event: protocol.TriggerEventPush, Ref: "refs/heads/main", Repo: "acme/app",
		Sha: headSHA, TriggerId: id, Trust: protocol.TriggerTrustTrusted, Seq: &seq, HubSeq: seq,
	}
	if pr {
		base := baseSHA
		t.Event = protocol.TriggerEventPullRequest
		t.Ref = "refs/pull/7/head"
		t.BaseSha = &base
		t.Pr = &protocol.TriggerPr{HeadRef: "feature", HeadRepoFullName: "acme/app", Number: 7}
	}
	return t
}

// waitTrigger waits until trigger id reaches state.
func (h *harness) waitTrigger(id string, state store.TriggerState) store.Trigger {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		trs, err := h.st.ListTriggers(h.ctx, state)
		if err != nil {
			h.t.Fatal(err)
		}
		for _, tr := range trs {
			if tr.ID == id {
				return tr
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatalf("trigger %s never reached %s", id, state)
	return store.Trigger{}
}

// frames returns the outbox frames of kind, decoded into maps.
func (h *harness) frames(kind string) []map[string]any {
	h.t.Helper()
	items, err := h.st.Pending(h.ctx, 0, 0)
	if err != nil {
		h.t.Fatal(err)
	}
	var out []map[string]any
	for _, it := range items {
		if it.Kind != kind {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(it.Payload, &m); err != nil {
			h.t.Fatal(err)
		}
		out = append(out, m)
	}
	return out
}

func (h *harness) runCount() int {
	h.t.Helper()
	runs, err := h.st.ListRuns(h.ctx, store.RunFilter{})
	if err != nil {
		h.t.Fatal(err)
	}
	return len(runs)
}

func TestDaemonDuplicateTrigger(t *testing.T) {
	h := newHarness(t, &fakeSource{Head: map[string]string{ConfigFile: unitOnly}}, &fakeRunner{})
	tr := h.trigger("trg_1", false)
	h.send(tr)
	h.send(tr)
	h.waitTrigger("trg_1", store.TriggerDone)

	if acc := h.frames("accepted"); len(acc) != 1 || acc[0]["trigger_id"] != "trg_1" {
		t.Fatalf("accepted frames = %v, want one for trg_1", acc)
	}
	if len(h.execs) != 1 || h.runCount() != 1 {
		t.Fatalf("executions = %v, runs = %d, want one", h.execs, h.runCount())
	}
	if !slices.Equal(h.runner.jobs, []string{"unit"}) {
		t.Fatalf("jobs run = %v, want [unit]", h.runner.jobs)
	}
	run, err := h.st.GetRun(h.ctx, h.frames("accepted")[0]["run_id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if run.State != store.RunSuccess || run.TriggerID != "trg_1" || run.Event != "push" || run.TrustDomain != "trusted:acme/app" {
		t.Fatalf("run = %+v", run)
	}
}

func TestDaemonNoConfigRejected(t *testing.T) {
	h := newHarness(t, &fakeSource{Head: map[string]string{"README.md": "hello\n"}}, &fakeRunner{})
	h.send(h.trigger("trg_1", false))
	tr := h.waitTrigger("trg_1", store.TriggerRejected)

	rej := h.frames("rejected")
	if len(rej) != 1 || rej[0]["trigger_id"] != "trg_1" || rej[0]["reason"] != ReasonNoConfig {
		t.Fatalf("rejected frames = %v, want one no_config for trg_1", rej)
	}
	if len(h.execs) != 0 || h.runCount() != 0 {
		t.Fatalf("executions = %v, runs = %d, want none", h.execs, h.runCount())
	}
	if _, err := os.Stat(filepath.Join(h.d.o.StateDir, "runs", tr.RunID)); !os.IsNotExist(err) {
		t.Fatalf("run dir of a rejected trigger left behind: %v", err)
	}
}

func TestDaemonBaseConfigBootstrap(t *testing.T) {
	h := newHarness(t, &fakeSource{
		Head: map[string]string{ConfigFile: unitAndLint},
		Base: map[string]string{ConfigFile: unitOnly},
	}, &fakeRunner{})
	h.send(h.trigger("trg_1", true))
	tr := h.waitTrigger("trg_1", store.TriggerDone)

	if len(h.execs) != 1 || !slices.Equal(h.execs[0], []string{"unit"}) {
		t.Fatalf("executor checks = %v, want the base jobs [unit]", h.execs)
	}
	if !slices.Equal(h.runner.jobs, []string{"unit"}) {
		t.Fatalf("jobs run = %v, want [unit]", h.runner.jobs)
	}
	var configEvents []map[string]any
	for _, ev := range h.frames("event") {
		if ev["job"] == ConfigJob {
			configEvents = append(configEvents, ev)
		}
	}
	if len(configEvents) != 1 || configEvents[0]["state"] != "success" || configEvents[0]["run_id"] != tr.RunID {
		t.Fatalf("_config events = %v, want one success", configEvents)
	}
	run, err := h.st.GetRun(h.ctx, tr.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if run.Event != "pull_request" || run.PR == nil || *run.PR != 7 || run.BaseSHA != baseSHA {
		t.Fatalf("run = %+v, want pull_request 7 on base %s", run, baseSHA)
	}
}

func TestDaemonHeadConfigErrorsAnnotated(t *testing.T) {
	h := newHarness(t, &fakeSource{
		Head: map[string]string{ConfigFile: "version: 1\nchecks:\n  jobs:\n    unit:\n      needs: [nope]\n"},
		Base: map[string]string{ConfigFile: unitOnly},
	}, &fakeRunner{})
	h.send(h.trigger("trg_1", true))
	h.waitTrigger("trg_1", store.TriggerDone)

	var state any
	for _, ev := range h.frames("event") {
		if ev["job"] == ConfigJob {
			state = ev["state"]
		}
	}
	ann := h.frames("annotations")
	if state != "failed" || len(ann) != 1 || ann[0]["job"] != ConfigJob {
		t.Fatalf("_config state = %v, annotations = %v, want failed with annotations", state, ann)
	}
	for _, it := range ann[0]["items"].([]any) {
		item := it.(map[string]any)
		if item["path"] != ConfigFile || item["line"].(float64) < 1 {
			t.Fatalf("annotation = %v, want path %s and a line", item, ConfigFile)
		}
	}
	if !slices.Equal(h.runner.jobs, []string{"unit"}) {
		t.Fatalf("jobs run = %v, want the base jobs [unit]", h.runner.jobs)
	}
}

// slackPlans returns the slack block of every job_planned frame, nil where a
// frame has none.
func (h *harness) slackPlans() []any {
	var out []any
	for _, f := range h.frames("job_planned") {
		out = append(out, f["slack"])
	}
	return out
}

func TestDaemonSlackOverrideFromConfig(t *testing.T) {
	h := newHarness(t, &fakeSource{Head: map[string]string{
		ConfigFile: unitOnly + "notify:\n  slack:\n    channel: \"#deploys\"\n    notify: verbose\n    alert: dm\n",
	}}, &fakeRunner{})
	h.send(h.trigger("trg_1", false))
	h.waitTrigger("trg_1", store.TriggerDone)

	want := []any{map[string]any{"channel": "#deploys", "notify": "verbose", "alert": "dm"}}
	if got := h.slackPlans(); !reflect.DeepEqual(got, want) {
		t.Fatalf("job_planned slack = %v, want %v", got, want)
	}
}

// A pull request's own notify.slack never reaches the hub: the base's does,
// and the _config pseudo job's frame carries none.
func TestDaemonSlackOverrideIgnoresPullRequestHead(t *testing.T) {
	for name, tc := range map[string]struct {
		base string
		want []any
	}{
		"base without notify": {base: unitOnly, want: []any{nil, nil}},
		"base with notify": {
			base: unitOnly + "notify:\n  slack:\n    channel: deploys\n",
			want: []any{map[string]any{"channel": "deploys"}, nil},
		},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, &fakeSource{
				Head: map[string]string{ConfigFile: unitOnly + "notify:\n  slack:\n    channel: elsewhere\n    notify: quiet\n"},
				Base: map[string]string{ConfigFile: tc.base},
			}, &fakeRunner{})
			h.send(h.trigger("trg_1", true))
			h.waitTrigger("trg_1", store.TriggerDone)

			if got := h.slackPlans(); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("job_planned slack = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestDaemonInterrupt(t *testing.T) {
	h := newHarness(t, &fakeSource{Head: map[string]string{ConfigFile: unitOnly}}, &fakeRunner{Block: true})
	h.send(h.trigger("trg_1", false))
	tr := h.waitTrigger("trg_1", store.TriggerRunning)
	<-h.runner.running

	runID := tr.RunID
	h.send(protocol.Interrupt{RunId: &runID, Reason: protocol.InterruptReasonSuperseded, Seq: new(9)})
	h.waitTrigger("trg_1", store.TriggerDone)

	run, err := h.st.GetRun(h.ctx, runID)
	if err != nil {
		t.Fatal(err)
	}
	if run.State != store.RunCancelled || run.Reason != "superseded" {
		t.Fatalf("run = %s %q, want cancelled superseded", run.State, run.Reason)
	}
	h.runner.mu.Lock()
	defer h.runner.mu.Unlock()
	if !h.runner.cancelled {
		t.Fatal("the running job was not cancelled")
	}
}

func TestDaemonInterruptDuringCheckout(t *testing.T) {
	h := newHarness(t, &fakeSource{Block: true}, &fakeRunner{})
	h.send(h.trigger("trg_1", false))
	<-h.src.started

	id := "trg_1"
	h.send(protocol.Interrupt{TriggerId: &id, Reason: protocol.InterruptReasonRevoked, Seq: new(9)})
	tr := h.waitTrigger("trg_1", store.TriggerDone)

	evs := h.frames("event")
	if len(evs) != 1 || evs[0]["run_id"] != tr.RunID || evs[0]["state"] != "cancelled" || evs[0]["reason"] != "revoked" {
		t.Fatalf("events = %v, want one cancelled revoked", evs)
	}
	if len(h.execs) != 0 || h.runCount() != 0 {
		t.Fatalf("executions = %v, runs = %d, want none", h.execs, h.runCount())
	}
}

func TestDaemonRecoversUnstartedTrigger(t *testing.T) {
	stateDir := t.TempDir()
	st, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	if _, err := st.AcceptTrigger(ctx, "trg_1", "run_1"); err != nil {
		t.Fatal(err)
	}
	d := New(&agentconf.AgentConfig{HubURL: "https://hub.invalid"}, st, nil, Options{StateDir: stateDir, Source: &fakeSource{}})
	if err := d.recoverTriggers(ctx); err != nil {
		t.Fatal(err)
	}
	if trs, err := st.ListTriggers(ctx, store.TriggerDone); err != nil || len(trs) != 1 {
		t.Fatalf("done triggers = %v, %v, want trg_1", trs, err)
	}
	items, err := st.Pending(ctx, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	last := items[len(items)-1]
	var ev protocol.Event
	if err := json.Unmarshal(last.Payload, &ev); err != nil {
		t.Fatal(err)
	}
	if last.Kind != "event" || ev.RunId != "run_1" || ev.State != protocol.EventStateInterrupted {
		t.Fatalf("last frame = %s %s, want run_1 interrupted", last.Kind, last.Payload)
	}
}

// A store left by a replaced agent holds frames and high-water marks of a hub
// session the new agent's hub has never seen; the daemon drops them before
// it dials.
func TestDaemonDropsReplacedAgentSession(t *testing.T) {
	stateDir := t.TempDir()
	st, err := store.Open(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := st.BindAgent(ctx, "agt_old"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AcceptTrigger(ctx, "trg_1", "run_1"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetHWM(ctx, store.HWMIn, 7); err != nil {
		t.Fatal(err)
	}

	dialer := &idleDialer{dialed: make(chan struct{})}
	d := New(&agentconf.AgentConfig{HubURL: "https://hub.invalid", AgentID: "agt_new", Credential: "zc_agent_x"}, st, nil,
		Options{StateDir: stateDir, Dialer: dialer, Source: &fakeSource{}})
	done := make(chan error, 1)
	go func() { done <- d.Run(ctx) }()
	select {
	case <-dialer.dialed:
	case err := <-done:
		t.Fatalf("Run = %v before dialing", err)
	}
	if items, err := st.Pending(ctx, 0, 0); err != nil || len(items) != 0 {
		t.Errorf("pending = %d items, %v; want none", len(items), err)
	}
	if hwm, err := st.GetHWM(ctx, store.HWMIn); err != nil || hwm != 0 {
		t.Errorf("in hwm = %d, %v; want 0", hwm, err)
	}
	cancel()
	if err := <-done; err != context.Canceled {
		t.Errorf("Run = %v, want context.Canceled", err)
	}
}

// logHub records the job logs PUT to it and the job's state in the agent
// store at upload time.
type logHub struct {
	h     **harness
	mu    sync.Mutex
	calls []logPut
}

type logPut struct {
	path, auth, body string
	jobState         store.JobState
}

func (l *logHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	zr, err := gzip.NewReader(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h := *l.h
	runID := strings.Split(r.URL.Path, "/")[3]
	jobs, err := h.st.Jobs(context.Background(), runID)
	if err != nil || len(jobs) == 0 {
		http.Error(w, "no such run", http.StatusNotFound)
		return
	}
	l.mu.Lock()
	l.calls = append(l.calls, logPut{path: r.URL.Path, auth: r.Header.Get("Authorization"), body: string(body), jobState: jobs[0].State})
	l.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func TestDaemonJobLogs(t *testing.T) {
	tests := []struct {
		name      string
		config    string
		wantPuts  int
		wantLocal bool
	}{
		{"uploads before the job settles", unitOnly, 1, false},
		{"logs local never uploads", unitOnly + "logs: local\n", 0, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var h *harness
			hub := &logHub{h: &h}
			srv := httptest.NewServer(hub)
			defer srv.Close()
			h = newHarnessAt(t, &fakeSource{Head: map[string]string{ConfigFile: tc.config}}, &fakeRunner{Log: "hello\n"}, srv.URL)
			h.send(h.trigger("trg_1", false))
			h.waitTrigger("trg_1", store.TriggerDone)

			runID := h.frames("accepted")[0]["run_id"].(string)
			hub.mu.Lock()
			calls := hub.calls
			hub.mu.Unlock()
			if len(calls) != tc.wantPuts {
				t.Fatalf("hub saw %d log PUTs, want %d", len(calls), tc.wantPuts)
			}
			for _, c := range calls {
				if c.path != "/v1/logs/"+runID+"/unit" || c.auth != "Bearer zc_agent_x" || c.body != "hello\n" {
					t.Errorf("log PUT = %+v", c)
				}
				if c.jobState != store.JobRunning {
					t.Errorf("job state at upload = %s, want running", c.jobState)
				}
			}
			var settled map[string]any
			for _, ev := range h.frames("event") {
				if ev["job"] == "unit" && ev["state"] == string(store.JobSuccess) {
					settled = ev
				}
			}
			if settled == nil {
				t.Fatal("no success event for unit")
			}
			if got := settled["logs"] == "local"; got != tc.wantLocal {
				t.Errorf("success event logs = %v, want local %v", settled["logs"], tc.wantLocal)
			}
		})
	}
}
