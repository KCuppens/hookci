package recovery

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation/isolationtest"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/services"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// fakeNetns lists Names and drops each removed name from it.
type fakeNetns struct {
	Names   []string
	Removed []string
	// OnRemove runs before each removal.
	OnRemove func()
}

func (f *fakeNetns) ListNamespaces(context.Context) ([]string, error) {
	return slices.Clone(f.Names), nil
}

func (f *fakeNetns) RemoveNamespace(_ context.Context, name string) error {
	if f.OnRemove != nil {
		f.OnRemove()
	}
	f.Removed = append(f.Removed, name)
	f.Names = slices.DeleteFunc(f.Names, func(n string) bool { return n == name })
	return nil
}

// fakeDocker lists containers of the run IDs in Runs, records the labels it
// was asked to remove and fails both with Err.
type fakeDocker struct {
	Runs   []string
	Labels []string
	Err    error
	// OnRemove runs before each removal.
	OnRemove func()
}

func (f *fakeDocker) RunIDs(context.Context) ([]string, error) {
	if f.Err != nil {
		return nil, f.Err
	}
	return slices.Clone(f.Runs), nil
}

func (f *fakeDocker) RemoveByLabel(_ context.Context, label string) error {
	if f.OnRemove != nil {
		f.OnRemove()
	}
	f.Labels = append(f.Labels, label)
	return f.Err
}

type harness struct {
	t         *testing.T
	ctx       context.Context
	db        *store.Store
	iso       *isolationtest.Fake
	isolation isolation.Isolation // what Recover gets; iso unless a test swaps it
	netns     *fakeNetns
	docker    *fakeDocker
	runner    *execx.Fake
}

// newHarness opens a temp store and fakes every cleanup dependency. pkill
// reports no match unless a test registers another response first.
func newHarness(t *testing.T) *harness {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "zeroci.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	iso := isolationtest.NewFake()
	return &harness{
		t:         t,
		ctx:       context.Background(),
		db:        db,
		iso:       iso,
		isolation: iso,
		netns:     &fakeNetns{},
		docker:    &fakeDocker{},
		runner:    &execx.Fake{},
	}
}

func (h *harness) recover() (Report, error) {
	h.t.Helper()
	h.runner.On("pkill", nil, execx.FakeResponse{Code: 1})
	return Recover(h.ctx, Deps{
		Store:     h.db,
		Isolation: h.isolation,
		Netns:     h.netns,
		Docker:    h.docker,
		Runner:    h.runner,
		Logger:    slog.New(slog.DiscardHandler),
	})
}

// mustRecover runs Recover and fails on a returned error or a cleanup error.
func (h *harness) mustRecover() Report {
	h.t.Helper()
	rep, err := h.recover()
	if err != nil {
		h.t.Fatalf("Recover: %v", err)
	}
	if len(rep.Errors) != 0 {
		h.t.Fatalf("Recover cleanup errors: %v", rep.Errors)
	}
	return rep
}

// runPath lists the run transitions that lead from queued to each state.
var runPath = map[store.RunState][]store.RunState{
	store.RunQueued:      nil,
	store.RunRunning:     {store.RunRunning},
	store.RunVerifying:   {store.RunRunning, store.RunVerifying},
	store.RunRollingBack: {store.RunRunning, store.RunVerifying, store.RunRollingBack},
	store.RunSuccess:     {store.RunRunning, store.RunSuccess},
	store.RunFailed:      {store.RunRunning, store.RunFailed},
}

// jobPath lists the job transitions that lead from queued to each state.
var jobPath = map[store.JobState][]store.JobState{
	store.JobQueued:  nil,
	store.JobRunning: {store.JobRunning},
	store.JobSuccess: {store.JobRunning, store.JobSuccess},
	store.JobFailed:  {store.JobRunning, store.JobFailed},
}

// seed creates run in state with one job per jobs entry, each moved to its
// state. Jobs are named in order: job0, job1, ...
func (h *harness) seed(r store.Run, state store.RunState, jobs ...store.JobState) store.Run {
	h.t.Helper()
	if r.Repo == "" {
		r.Repo = "acme/app"
	}
	if r.SHA == "" {
		r.SHA = "abc123"
	}
	if r.Event == "" {
		r.Event = "push"
	}
	if r.Kind == "" {
		r.Kind = "check"
	}
	if r.Event != "local" {
		r.TriggerID = "trig-" + r.ID
		if _, err := h.db.AcceptTrigger(h.ctx, r.TriggerID, r.ID); err != nil {
			h.t.Fatalf("AcceptTrigger %s: %v", r.TriggerID, err)
		}
	}
	r.TrustDomain = "trusted:" + r.Repo
	planned := make([]store.Job, len(jobs))
	for i := range jobs {
		planned[i] = store.Job{Name: fmt.Sprintf("job%d", i)}
	}
	if err := h.db.CreateRun(h.ctx, r, planned); err != nil {
		h.t.Fatalf("CreateRun %s: %v", r.ID, err)
	}
	from := store.RunQueued
	for _, to := range runPath[state] {
		if err := h.db.Transition(h.ctx, r.ID, []store.RunState{from}, to, ""); err != nil {
			h.t.Fatalf("run %s %s -> %s: %v", r.ID, from, to, err)
		}
		from = to
	}
	for i, js := range jobs {
		jfrom := store.JobQueued
		for _, to := range jobPath[js] {
			if err := h.db.TransitionJob(h.ctx, r.ID, planned[i].Name, []store.JobState{jfrom}, to, store.JobUpdate{}); err != nil {
				h.t.Fatalf("job %s/%s %s -> %s: %v", r.ID, planned[i].Name, jfrom, to, err)
			}
			jfrom = to
		}
	}
	return h.run(r.ID)
}

func (h *harness) run(id string) store.Run {
	h.t.Helper()
	r, err := h.db.GetRun(h.ctx, id)
	if err != nil {
		h.t.Fatalf("GetRun %s: %v", id, err)
	}
	return r
}

func (h *harness) jobStates(id string) []store.JobState {
	h.t.Helper()
	jobs, err := h.db.Jobs(h.ctx, id)
	if err != nil {
		h.t.Fatalf("Jobs %s: %v", id, err)
	}
	states := make([]store.JobState, len(jobs))
	for i, j := range jobs {
		states[i] = j.State
	}
	return states
}

func (h *harness) runCount() int {
	h.t.Helper()
	runs, err := h.db.ListRuns(h.ctx, store.RunFilter{})
	if err != nil {
		h.t.Fatalf("ListRuns: %v", err)
	}
	return len(runs)
}

func TestRecoverInterruptsRunningRun(t *testing.T) {
	h := newHarness(t)
	h.seed(store.Run{ID: "r1", Kind: "deploy", Env: "prod"}, store.RunRunning,
		store.JobSuccess, store.JobRunning, store.JobQueued, store.JobFailed)

	rep := h.mustRecover()

	if !reflect.DeepEqual(rep.Interrupted, []string{"r1"}) {
		t.Fatalf("Interrupted = %v, want [r1]", rep.Interrupted)
	}
	r := h.run("r1")
	if r.State != store.RunInterrupted || r.Reason != InterruptedReason {
		t.Fatalf("run = %s %q, want interrupted %q", r.State, r.Reason, InterruptedReason)
	}
	if r.FinishedAt == nil {
		t.Fatal("interrupted run has no finished_at")
	}
	want := []store.JobState{store.JobSuccess, store.JobInterrupted, store.JobInterrupted, store.JobFailed}
	if got := h.jobStates("r1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("job states = %v, want %v", got, want)
	}
	jobs, err := h.db.Jobs(h.ctx, "r1")
	if err != nil {
		t.Fatal(err)
	}
	for _, j := range jobs[1:3] {
		if j.Reason != InterruptedReason || j.ExitCode != nil {
			t.Fatalf("job %s reason %q exit %v, want %q and no exit code", j.Name, j.Reason, j.ExitCode, InterruptedReason)
		}
	}
}

func TestRecoverRequeuesCheck(t *testing.T) {
	h := newHarness(t)
	h.seed(store.Run{ID: "r1"}, store.RunRunning, store.JobSuccess, store.JobRunning, store.JobQueued)

	rep := h.mustRecover()

	if len(rep.Requeued) != 1 {
		t.Fatalf("Requeued = %v, want one retry", rep.Requeued)
	}
	retry := h.run(rep.Requeued[0])
	if retry.Attempt != 2 {
		t.Fatalf("retry attempt = %d, want 2", retry.Attempt)
	}
	if retry.RetryOf == nil || *retry.RetryOf != "r1" {
		t.Fatalf("retry RetryOf = %v, want r1", retry.RetryOf)
	}
	if retry.State != store.RunQueued {
		t.Fatalf("retry state = %s, want queued", retry.State)
	}
	want := []store.JobState{store.JobQueued, store.JobQueued, store.JobQueued}
	if got := h.jobStates(retry.ID); !reflect.DeepEqual(got, want) {
		t.Fatalf("retry job states = %v, want %v", got, want)
	}
	if r := h.run("r1"); r.State != store.RunInterrupted {
		t.Fatalf("original run state = %s, want interrupted", r.State)
	}
	triggers, err := h.db.ListTriggers(h.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(triggers) != 1 || triggers[0].RunID != retry.ID {
		t.Fatalf("triggers = %+v, want trig-r1 on run %s", triggers, retry.ID)
	}
}

// The retry takes over the trigger: the hub hears of it in an accepted
// frame before the interrupted run's events, so it renames the trigger's
// run instead of finishing it.
func TestRecoverReportsRetryAccepted(t *testing.T) {
	h := newHarness(t)
	h.seed(store.Run{ID: "r1"}, store.RunRunning, store.JobRunning)
	items, err := h.db.Pending(h.ctx, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	after := items[len(items)-1].Seq

	rep := h.mustRecover()

	items, err = h.db.Pending(h.ctx, after, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) == 0 || items[0].Kind != "accepted" {
		t.Fatalf("first frame after recovery = %+v, want accepted", items)
	}
	var acc protocol.Accepted
	if err := protocol.Unmarshal(items[0].Payload, &acc); err != nil {
		t.Fatal(err)
	}
	if acc.TriggerId != "trig-r1" || acc.RunId != rep.Requeued[0] {
		t.Fatalf("accepted = %+v, want trig-r1 on %s", acc, rep.Requeued[0])
	}
}

// A local zeroci run has no trigger and no daemon to run a retry, so it is
// only interrupted.
func TestRecoverLocalRunNotRequeued(t *testing.T) {
	h := newHarness(t)
	h.seed(store.Run{ID: "r1", Event: "local"}, store.RunRunning, store.JobRunning)

	rep := h.mustRecover()

	if len(rep.Requeued) != 0 || h.runCount() != 1 {
		t.Fatalf("local run re-queued: %v", rep.Requeued)
	}
	if got := h.run("r1").State; got != store.RunInterrupted {
		t.Fatalf("run state = %s, want interrupted", got)
	}
}

func TestRecoverAttemptCap(t *testing.T) {
	for _, tc := range []struct {
		attempt int
		requeue bool
	}{
		{attempt: MaxCheckAttempts - 1, requeue: true},
		{attempt: MaxCheckAttempts, requeue: false},
	} {
		t.Run(fmt.Sprintf("attempt%d", tc.attempt), func(t *testing.T) {
			h := newHarness(t)
			h.seed(store.Run{ID: "r1", Attempt: tc.attempt}, store.RunRunning, store.JobRunning)

			rep := h.mustRecover()

			if got := h.run("r1").State; got != store.RunInterrupted {
				t.Fatalf("run state = %s, want interrupted", got)
			}
			if !tc.requeue {
				if len(rep.Requeued) != 0 || h.runCount() != 1 {
					t.Fatalf("attempt %d re-queued: %v", tc.attempt, rep.Requeued)
				}
				return
			}
			if len(rep.Requeued) != 1 || h.run(rep.Requeued[0]).Attempt != tc.attempt+1 {
				t.Fatalf("attempt %d: Requeued = %v, want one retry on attempt %d", tc.attempt, rep.Requeued, tc.attempt+1)
			}
		})
	}
}

func TestRecoverDeployNotRequeued(t *testing.T) {
	h := newHarness(t)
	h.seed(store.Run{ID: "verify", Kind: "deploy", Env: "prod"}, store.RunVerifying, store.JobSuccess)
	h.seed(store.Run{ID: "rollback", Kind: "deploy", Env: "prod", SHA: "def456"}, store.RunRollingBack, store.JobSuccess)

	rep := h.mustRecover()

	slices.Sort(rep.Interrupted)
	if !reflect.DeepEqual(rep.Interrupted, []string{"rollback", "verify"}) {
		t.Fatalf("Interrupted = %v, want [rollback verify]", rep.Interrupted)
	}
	if len(rep.Requeued) != 0 || h.runCount() != 2 {
		t.Fatalf("deploy runs re-queued: %v", rep.Requeued)
	}
	for _, id := range []string{"verify", "rollback"} {
		if r := h.run(id); r.State != store.RunInterrupted || r.Reason != InterruptedReason {
			t.Fatalf("run %s = %s %q, want interrupted %q", id, r.State, r.Reason, InterruptedReason)
		}
	}
}

func TestRecoverLeavesTerminalRuns(t *testing.T) {
	h := newHarness(t)
	before := []store.Run{
		h.seed(store.Run{ID: "ok", SHA: "a"}, store.RunSuccess, store.JobSuccess),
		h.seed(store.Run{ID: "bad", SHA: "b"}, store.RunFailed, store.JobSuccess, store.JobFailed),
	}
	beforeJobs := [][]store.JobState{h.jobStates("ok"), h.jobStates("bad")}

	rep := h.mustRecover()

	if len(rep.Interrupted) != 0 || len(rep.Requeued) != 0 {
		t.Fatalf("terminal runs touched: interrupted %v, requeued %v", rep.Interrupted, rep.Requeued)
	}
	for i, want := range before {
		if got := h.run(want.ID); !reflect.DeepEqual(got, want) {
			t.Fatalf("run %s changed:\n got %+v\nwant %+v", want.ID, got, want)
		}
		if got := h.jobStates(want.ID); !reflect.DeepEqual(got, beforeJobs[i]) {
			t.Fatalf("run %s jobs = %v, want %v", want.ID, got, beforeJobs[i])
		}
	}
	if h.runCount() != 2 {
		t.Fatalf("run count = %d, want 2", h.runCount())
	}
}

func TestRecoverStopsUnitsAndNamespaces(t *testing.T) {
	h := newHarness(t)
	h.seed(store.Run{ID: "r1"}, store.RunRunning, store.JobRunning)
	h.seed(store.Run{ID: "r0", SHA: "sha-r0"}, store.RunSuccess, store.JobSuccess)
	h.iso.Units = []isolation.Unit{
		{Name: "zeroci-run-r1-build", Active: "active"},
		{Name: "other-service", Active: "active"},
		{Name: "zeroci-run-r0-test", Active: "failed"},
	}
	h.netns.Names = []string{"zc-r1", "other-ns", "zc-r0"}
	h.docker.Runs = []string{"r1", "r0"}

	rep := h.mustRecover()

	wantUnits := []string{"zeroci-run-r1-build", "zeroci-run-r0-test"}
	if !reflect.DeepEqual(h.iso.Stops, wantUnits) || !reflect.DeepEqual(rep.UnitsStopped, wantUnits) {
		t.Fatalf("stops = %v, report = %v, want %v", h.iso.Stops, rep.UnitsStopped, wantUnits)
	}
	wantNS := []string{"zc-r1", "zc-r0"}
	if !reflect.DeepEqual(h.netns.Removed, wantNS) || !reflect.DeepEqual(rep.NetnsRemoved, wantNS) {
		t.Fatalf("removed = %v, report = %v, want %v", h.netns.Removed, rep.NetnsRemoved, wantNS)
	}
	for _, ns := range wantNS {
		if !h.runner.Called("pkill", "-f", "^pasta .* --netns [^ ]*/"+ns+"$") {
			t.Fatalf("pkill not called for the pasta of %s: %+v", ns, h.runner.Calls)
		}
	}
	if want := []string{services.LabelRun + "=r1", services.LabelRun + "=r0"}; !reflect.DeepEqual(h.docker.Labels, want) {
		t.Fatalf("docker labels = %v, want %v", h.docker.Labels, want)
	}
}

// Another agent on the same host has its own store; its runs' units,
// namespaces, pasta processes and containers must survive this recovery.
func TestRecoverLeavesForeignRuns(t *testing.T) {
	h := newHarness(t)
	h.seed(store.Run{ID: "r1"}, store.RunRunning, store.JobRunning)
	h.iso.Units = []isolation.Unit{
		{Name: "zeroci-run-r1-build", Active: "active"},
		{Name: "zeroci-run-r1-unit-tests", Active: "active"},
		{Name: "zeroci-run-foreign-build", Active: "active"},
		{Name: "zeroci-run-r10-build", Active: "active"},
	}
	h.netns.Names = []string{"zc-r1", "zc-foreign", "zc-r10"}
	h.docker.Runs = []string{"foreign", "r10", "r1"}

	h.mustRecover()

	if want := []string{"zeroci-run-r1-build", "zeroci-run-r1-unit-tests"}; !reflect.DeepEqual(h.iso.Stops, want) {
		t.Fatalf("stops = %v, want %v", h.iso.Stops, want)
	}
	if want := []string{"zc-r1"}; !reflect.DeepEqual(h.netns.Removed, want) {
		t.Fatalf("removed namespaces = %v, want %v", h.netns.Removed, want)
	}
	if want := []string{services.LabelRun + "=r1"}; !reflect.DeepEqual(h.docker.Labels, want) {
		t.Fatalf("docker labels = %v, want %v", h.docker.Labels, want)
	}
	var pkills [][]string
	for _, c := range h.runner.Calls {
		if c.Name == "pkill" {
			pkills = append(pkills, c.Args)
		}
	}
	if want := [][]string{{"-f", "^pasta .* --netns [^ ]*/zc-r1$"}}; !reflect.DeepEqual(pkills, want) {
		t.Fatalf("pkill calls = %v, want %v", pkills, want)
	}
}

// Every process must be stopped before a run is marked interrupted, so the
// run's state never claims it is over while its job still runs.
func TestRecoverCleansBeforeInterrupting(t *testing.T) {
	h := newHarness(t)
	h.seed(store.Run{ID: "r1"}, store.RunRunning, store.JobRunning)
	h.netns.Names = []string{"zc-r1"}
	h.docker.Runs = []string{"r1"}
	var seen []store.RunState
	record := func() { seen = append(seen, h.run("r1").State) }
	h.netns.OnRemove = record
	h.docker.OnRemove = record

	h.mustRecover()

	if want := []store.RunState{store.RunRunning, store.RunRunning}; !reflect.DeepEqual(seen, want) {
		t.Fatalf("run state during cleanup = %v, want %v", seen, want)
	}
}

func TestRecoverIgnoresMissingDocker(t *testing.T) {
	h := newHarness(t)
	h.seed(store.Run{ID: "r1"}, store.RunRunning, store.JobRunning)
	h.docker.Err = fmt.Errorf("docker ps: %w", services.ErrDockerMissing)

	h.mustRecover()

	if got := h.run("r1").State; got != store.RunInterrupted {
		t.Fatalf("run state = %s, want interrupted", got)
	}
}

// A docker daemon that is down is a cleanup error: it is reported, and the
// run is still interrupted rather than left running forever.
func TestRecoverDockerDownStillInterrupts(t *testing.T) {
	h := newHarness(t)
	h.seed(store.Run{ID: "r1"}, store.RunRunning, store.JobRunning)
	daemonDown := errors.New("cannot connect to the docker daemon")
	h.docker.Err = daemonDown

	rep, err := h.recover()
	if err != nil {
		t.Fatalf("Recover returned %v, want only a reported cleanup error", err)
	}
	if len(rep.Errors) != 1 || !errors.Is(rep.Errors[0], daemonDown) {
		t.Fatalf("Errors = %v, want the docker error", rep.Errors)
	}
	if got := h.run("r1").State; got != store.RunInterrupted {
		t.Fatalf("run state = %s, want interrupted", got)
	}
}

func TestRecoverPkillNoMatch(t *testing.T) {
	for _, tc := range []struct {
		name    string
		resp    execx.FakeResponse
		wantErr bool
	}{
		{name: "no match", resp: execx.FakeResponse{Code: 1}},
		{name: "killed", resp: execx.FakeResponse{}},
		{name: "failed", resp: execx.FakeResponse{Code: 3, Stderr: "pkill: fatal"}, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t)
			h.seed(store.Run{ID: "r1"}, store.RunRunning, store.JobRunning)
			h.netns.Names = []string{"zc-r1"}
			h.runner.On("pkill", nil, tc.resp)

			rep, err := h.recover()
			if err != nil {
				t.Fatalf("Recover: %v", err)
			}
			var exitErr *execx.ExitError
			if tc.wantErr != (len(rep.Errors) == 1 && errors.As(rep.Errors[0], &exitErr)) {
				t.Fatalf("Errors = %v, want pkill error: %v", rep.Errors, tc.wantErr)
			}
		})
	}
}

func TestRecoverIdempotent(t *testing.T) {
	h := newHarness(t)
	h.seed(store.Run{ID: "r1"}, store.RunRunning, store.JobRunning)
	h.seed(store.Run{ID: "r2", Kind: "deploy", Env: "prod"}, store.RunVerifying, store.JobSuccess)
	h.iso.Units = []isolation.Unit{{Name: "zeroci-run-r1-job0", Active: "active"}}
	h.netns.Names = []string{"zc-r1"}

	first := h.mustRecover()
	if len(first.Interrupted) != 2 || len(first.UnitsStopped) != 1 || len(first.NetnsRemoved) != 1 {
		t.Fatalf("first Recover = %+v, want two runs, one unit, one namespace", first)
	}
	count := h.runCount()

	if second := h.mustRecover(); !reflect.DeepEqual(second, Report{}) {
		t.Fatalf("second Recover = %+v, want an empty report", second)
	}
	if h.runCount() != count {
		t.Fatalf("second Recover created runs: %d, want %d", h.runCount(), count)
	}
}

func TestRecoverOutboxEvents(t *testing.T) {
	h := newHarness(t)
	h.seed(store.Run{ID: "r1", Attempt: MaxCheckAttempts}, store.RunRunning, store.JobSuccess, store.JobRunning)
	items, err := h.db.Pending(h.ctx, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	after := items[len(items)-1].Seq

	h.mustRecover()

	items, err = h.db.Pending(h.ctx, after, 0)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, it := range items {
		if it.Kind != store.KindEvent {
			continue
		}
		var ev protocol.Event
		if err := protocol.Unmarshal(it.Payload, &ev); err != nil {
			t.Fatalf("decode event %d: %v", it.Seq, err)
		}
		if ev.AgentSeq != int(it.Seq) {
			t.Fatalf("event agent_seq = %d, want %d", ev.AgentSeq, it.Seq)
		}
		reason := ""
		if ev.Reason != nil {
			reason = *ev.Reason
		}
		target := ev.RunId
		if ev.Job != nil {
			target += "/" + *ev.Job
		}
		got = append(got, fmt.Sprintf("%s %s %s", target, ev.State, reason))
	}
	// Job events carry no reason; the store keeps it on the job row.
	want := []string{
		"r1/job1 interrupted ",
		"r1 interrupted " + InterruptedReason,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("events = %q, want %q", got, want)
	}
}

// Store errors are returned. Without the store Recover cannot tell its own
// resources from another agent's, so it sweeps nothing.
func TestRecoverReturnsStoreErrors(t *testing.T) {
	h := newHarness(t)
	h.iso.Units = []isolation.Unit{{Name: "zeroci-run-r1-job0", Active: "active"}}
	if err := h.db.Close(); err != nil {
		t.Fatal(err)
	}

	rep, err := h.recover()
	if err == nil {
		t.Fatal("Recover on a closed store returned no error")
	}
	if len(rep.UnitsStopped) != 0 || len(h.iso.Stops) != 0 {
		t.Fatalf("UnitsStopped = %v, want nothing stopped without the store", rep.UnitsStopped)
	}
}

func TestRecoverIgnoresUnsupportedIsolation(t *testing.T) {
	h := newHarness(t)
	h.seed(store.Run{ID: "r1"}, store.RunRunning, store.JobRunning)

	h.isolation = unsupportedIsolation{h.iso}
	rep, err := h.recover()
	if err != nil || len(rep.Errors) != 0 {
		t.Fatalf("Recover = %v, errors %v; want ErrUnsupported ignored", err, rep.Errors)
	}
	if got := h.run("r1").State; got != store.RunInterrupted {
		t.Fatalf("run state = %s, want interrupted", got)
	}
}

// unsupportedIsolation fails ListUnits the way a backend that cannot list
// units does.
type unsupportedIsolation struct{ *isolationtest.Fake }

func (unsupportedIsolation) ListUnits(context.Context, string) ([]isolation.Unit, error) {
	return nil, isolation.ErrUnsupported
}
