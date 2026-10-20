// Package daemon is zeroci agent: it keeps the hub session open, checks out
// and runs every trigger the hub sends and reports the run back over the
// same session.
package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/agentconf"
	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/control"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy"
	"github.com/KCuppens/zerocideploy/agent/internal/deploy/trigger"
	"github.com/KCuppens/zerocideploy/agent/internal/executor"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/gc"
	"github.com/KCuppens/zerocideploy/agent/internal/hubclient"
	"github.com/KCuppens/zerocideploy/agent/internal/hubtokens"
	"github.com/KCuppens/zerocideploy/agent/internal/ids"
	"github.com/KCuppens/zerocideploy/agent/internal/logupload"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/recovery"
	"github.com/KCuppens/zerocideploy/agent/internal/scheduler"
	"github.com/KCuppens/zerocideploy/agent/internal/sink"
	"github.com/KCuppens/zerocideploy/agent/internal/source"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// Reasons of the rejected frame.
const (
	ReasonFetchFailed   = "fetch_failed"
	ReasonSHAMismatch   = "sha_mismatch"
	ReasonNoConfig      = "no_config"
	ReasonConfigInvalid = "config_invalid"
	ReasonAgentError    = "agent_error"
)

// flushInterval is how often the hub client is woken to send the outbox rows
// the executor appends through the store.
const flushInterval = 100 * time.Millisecond

// ExecutorFunc builds the runner of one checked-out run whose checks are
// already resolved, held to policy.
type ExecutorFunc func(co source.Checkout, checks *config.ResolvedChecks, policy executor.RunPolicy) (scheduler.JobRunner, error)

// Options configures a Daemon.
type Options struct {
	StateDir string
	Version  string
	Dialer   hubclient.Dialer // nil: real websocket dialer
	Clock    clock.Clock      // nil: real clock
	Logger   *slog.Logger     // nil: discard
	// Source checks runs out; nil fetches from GitHub with hub-issued tokens.
	Source  source.Source
	JobUser executor.JobUser
	Slots   int // job slots of a run; <= 0 means scheduler.DefaultSlots()
	// Deploys decides triggers that name an env; nil checks GitHub with
	// hub-issued tokens and records accepted runs in the store.
	Deploys DeployIntake
	// DeployRunner runs deploy units and proxy reloads; nil: the OS.
	DeployRunner execx.Runner
	// DeployUser owns deploy checkouts; "" means deploy.DeployUser, the
	// account deploy units run as.
	DeployUser string
	// HealthClient probes deploy health URLs; nil: the zero http.Client.
	HealthClient *http.Client
}

// Daemon runs the hub's triggers one at a time, in the order they arrive.
type Daemon struct {
	agentID string
	st      *store.Store
	exec    ExecutorFunc
	o       Options
	clk     clock.Clock
	log     *slog.Logger
	client  *hubclient.Client
	tokens  *hubtokens.Broker
	src     source.Source
	logs    *logupload.Uploader

	wake    chan struct{}
	mu      sync.Mutex
	queue   []*work // accepted, not started
	current *work

	deploys     DeployIntake
	deployWake  chan struct{}
	deployQ     []protocol.Trigger // guarded by mu
	deploying   map[string]bool    // trigger ids queued or being decided; guarded by mu
	deploySched *deploy.Scheduler  // runs accepted deploy runs
	collector   *gc.Collector      // removes old deploy images and run dirs
}

// work is one accepted trigger.
type work struct {
	trig  protocol.Trigger
	runID string

	// Set when the worker takes it; guarded by Daemon.mu after that.
	ctx         context.Context
	cancel      context.CancelFunc
	started     bool                 // its run exists in the store
	sched       *scheduler.Scheduler // set once the run is submitted
	interrupted string               // interrupt reason, "" when none
}

// New returns a Daemon for the agent conf over st. exec builds the runner of
// each run.
func New(conf *agentconf.AgentConfig, st *store.Store, exec ExecutorFunc, o Options) *Daemon {
	if o.Clock == nil {
		o.Clock = clock.Real{}
	}
	if o.Logger == nil {
		o.Logger = slog.New(slog.DiscardHandler)
	}
	d := &Daemon{
		agentID: conf.AgentID, st: st, exec: exec, o: o, clk: o.Clock, log: o.Logger, wake: make(chan struct{}, 1),
		deploys: o.Deploys, deployWake: make(chan struct{}, 1), deploying: map[string]bool{},
	}
	credential := conf.Credential
	d.logs = &logupload.Uploader{HubURL: conf.HubURL, Token: func() string { return credential }}
	d.client = hubclient.New(hubclient.Config{
		HubURL:     conf.HubURL,
		AgentID:    conf.AgentID,
		Credential: conf.Credential,
		Version:    o.Version,
		Dialer:     o.Dialer,
		Clock:      o.Clock,
	}, st, d, o.Logger)
	d.tokens = hubtokens.New(d.client, o.Clock)
	d.src = o.Source
	if d.src == nil {
		d.src = &source.HubSource{Tokens: d.tokens.Request, WorkRoot: filepath.Join(o.StateDir, "work")}
	}
	github := &http.Client{Timeout: githubTimeout}
	if d.deploys == nil {
		d.deploys = &hubIntake{
			base:   trigger.Intake{Store: st, Clock: o.Clock.Now, NewRunID: ids.NewRunID},
			http:   github,
			tokens: d.tokens.RequestTrigger,
		}
	}
	d.deploySched = d.newDeployScheduler(credential, hubDeployEvents{client: d.client, log: o.Logger}, githubDeployment("", github, d.tokens.Request))
	d.collector = newCollector(st, o, conf.AgentConfig)
	d.deploySched.LoadDeployment = recordGCTargets(st, o, d.deploySched.LoadDeployment)
	d.deploySched.PostRun = func(ctx context.Context, _ store.DeployRun) { d.collector.RunBestEffort(ctx) }
	return d
}

// Run settles the triggers an earlier daemon left unfinished, drops the hub
// session state of a replaced agent, then serves the hub session until ctx
// ends or the hub refuses the agent. It returns hubclient.ErrRevoked,
// hubclient.ErrUnsupported or ctx.Err(). A run still going when Run returns
// is recorded as interrupted.
func (d *Daemon) Run(ctx context.Context) error {
	if hs, ok := d.src.(*source.HubSource); ok {
		if err := os.MkdirAll(hs.WorkRoot, 0o700); err != nil {
			return fmt.Errorf("daemon: create work dir: %w", err)
		}
	}
	if err := d.recoverTriggers(ctx); err != nil {
		return err
	}
	if err := d.recoverDeploys(ctx); err != nil {
		return err
	}
	reset, err := d.st.BindAgent(ctx, d.agentID)
	if err != nil {
		return fmt.Errorf("daemon: %w", err)
	}
	if reset {
		d.log.Info("agent re-paired: dropped the previous agent's unsent frames", "agent", d.agentID)
	}
	wctx, stop := context.WithCancel(ctx)
	var wg sync.WaitGroup
	// A control socket that cannot start only disables the CLI commands
	// that use it; exiting would keep the unit down (RestartPreventExitStatus).
	if ctl, err := control.Listen(d.o.StateDir, d.log); err != nil {
		d.log.Error("control socket unavailable; zeroci gc and retry will not reach this agent", "err", err)
	} else {
		ctl.Handle("gc", d.collector.HandleControl)
		ctl.Handle(deploy.RetryOp, deploy.RetryControl(d.st, d.deploySched))
		wg.Go(func() {
			if err := ctl.Serve(wctx); err != nil {
				d.log.Error("control socket stopped", "err", err)
			}
		})
	}
	wg.Go(func() { d.worker(wctx) })
	wg.Go(func() { d.flushLoop(wctx) })
	wg.Go(func() { d.deployWorker(wctx) })
	wg.Go(func() { d.deploySched.Run(wctx) })
	err = d.client.Run(ctx)
	stop()
	wg.Wait()
	d.deploySched.Wait()
	return err
}

// HandleFrame implements hubclient.Handler. It never blocks on a run:
// trigger work happens on the worker, which itself waits for token frames
// arriving here.
func (d *Daemon) HandleFrame(ctx context.Context, f protocol.Frame) error {
	switch v := f.(type) {
	case protocol.Trigger:
		if v.Env != nil && *v.Env != "" {
			d.queueDeploy(v)
			return nil
		}
		return d.accept(ctx, v)
	case protocol.Token:
		d.tokens.Deliver(v)
	case protocol.Interrupt:
		d.interrupt(ctx, v)
	}
	return nil
}

// TokenRefused implements hubclient.TokenRefusals: a refusal that arrives
// while a deploy trigger's checks wait for their token fails those checks,
// and the trigger is rejected, instead of ending the session as revoked.
func (d *Daemon) TokenRefused(e protocol.Error) bool {
	return d.tokens.Refuse(e.Message)
}

// accept records t and queues it. A trigger already recorded is ignored:
// the hub resends frames it has not seen acknowledged.
func (d *Daemon) accept(ctx context.Context, t protocol.Trigger) error {
	runID := ids.NewRunID()
	ok, err := d.st.AcceptTrigger(ctx, t.TriggerId, runID)
	if err != nil {
		return fmt.Errorf("daemon: %w", err)
	}
	if !ok {
		d.log.Info("duplicate trigger ignored", "trigger", t.TriggerId)
		return nil
	}
	d.client.Flush()
	d.mu.Lock()
	d.queue = append(d.queue, &work{trig: t, runID: runID})
	d.mu.Unlock()
	select {
	case d.wake <- struct{}{}:
	default:
	}
	return nil
}

// interrupt stops the run or trigger it names: a queued trigger is dropped,
// one being checked out is aborted and a submitted run is cancelled. An
// unknown or finished one is ignored.
func (d *Daemon) interrupt(ctx context.Context, it protocol.Interrupt) {
	reason := string(it.Reason)
	match := func(w *work) bool {
		return (it.RunId != nil && *it.RunId == w.runID) || (it.TriggerId != nil && *it.TriggerId == w.trig.TriggerId)
	}
	d.mu.Lock()
	if i := slices.IndexFunc(d.queue, match); i >= 0 {
		w := d.queue[i]
		d.queue = slices.Delete(d.queue, i, i+1)
		d.mu.Unlock()
		d.endUnstarted(ctx, w.trig.TriggerId, w.runID, protocol.EventStateCancelled, reason)
		return
	}
	w := d.current
	if w == nil || !match(w) || w.interrupted != "" {
		d.mu.Unlock()
		return
	}
	w.interrupted = reason
	if !w.started {
		w.cancel()
	}
	sched := w.sched
	d.mu.Unlock()
	if sched != nil {
		d.cancelRun(ctx, sched, w.runID, reason)
	}
}

func (d *Daemon) cancelRun(ctx context.Context, sched *scheduler.Scheduler, runID, reason string) {
	if err := sched.Cancel(context.WithoutCancel(ctx), runID, reason); err != nil {
		d.log.Error("cancel run failed", "run", runID, "err", err)
	}
}

func (d *Daemon) worker(ctx context.Context) {
	for {
		w := d.next(ctx)
		if w == nil {
			return
		}
		d.process(ctx, w)
		w.cancel()
		d.mu.Lock()
		d.current = nil
		d.mu.Unlock()
	}
}

// next takes the oldest queued trigger, or returns nil once ctx ends.
func (d *Daemon) next(ctx context.Context) *work {
	for {
		if ctx.Err() != nil {
			return nil
		}
		d.mu.Lock()
		if len(d.queue) > 0 {
			w := d.queue[0]
			d.queue = d.queue[1:]
			w.ctx, w.cancel = context.WithCancel(ctx)
			d.current = w
			d.mu.Unlock()
			return w
		}
		d.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil
		case <-d.wake:
		}
	}
}

// process checks w out, resolves its checks and runs them. ctx ending
// (daemon shutdown) leaves an unstarted trigger accepted for the next start
// to settle and interrupts a started run.
func (d *Daemon) process(ctx context.Context, w *work) {
	bg := context.WithoutCancel(ctx)
	t := w.trig
	dir, err := executor.NewRunDir(d.o.StateDir, w.runID, d.o.JobUser)
	if err != nil {
		d.reject(bg, w, ReasonAgentError, err)
		return
	}
	req := source.Request{Repo: t.Repo, SHA: t.Sha, Ref: t.Ref, RunAs: d.o.JobUser.Cred, RunID: w.runID}
	if t.BaseSha != nil {
		req.BaseSHA = *t.BaseSha
	}
	co, err := d.src.Checkout(w.ctx, req, dir.Src())
	if err != nil {
		_ = os.RemoveAll(dir.Root)
		if d.stopped(ctx, w) {
			return
		}
		reason := ReasonFetchFailed
		if errors.Is(err, source.ErrSHAMismatch) {
			reason = ReasonSHAMismatch
		}
		d.reject(bg, w, reason, err)
		return
	}
	defer co.Release()
	discard := func() { _ = os.RemoveAll(dir.Root) }

	p, err := resolvePlan(co)
	switch {
	case err != nil:
		discard()
		d.reject(bg, w, ReasonAgentError, err)
		return
	case p.invalid != nil:
		discard()
		d.reject(bg, w, ReasonConfigInvalid, errors.New(p.invalid.Format(ConfigFile)))
		return
	case p.checks == nil:
		discard()
		d.reject(bg, w, ReasonNoConfig, errors.New("no checks configured or detected"))
		return
	}
	policy := optionsForTrust(t.Trust)
	inner, err := d.exec(co, p.checks, policy)
	if err != nil {
		discard()
		d.reject(bg, w, ReasonAgentError, err)
		return
	}
	runner := &logRunner{JobRunner: inner, up: d.logs, runDir: dir.Root, local: p.checks.LogsLocal, log: d.log}

	d.mu.Lock()
	if w.ctx.Err() == nil {
		w.started = true
	}
	d.mu.Unlock()
	if !w.started {
		discard()
		d.stopped(ctx, w)
		return
	}
	run := storeRun(t, w.runID, co.SHA)
	run.Slack = p.slack
	if err := d.st.CreateRun(bg, run, storeJobs(p.checks)); err != nil {
		discard()
		d.reject(bg, w, ReasonAgentError, err)
		return
	}
	if err := d.st.SetTriggerState(bg, t.TriggerId, store.TriggerRunning); err != nil {
		d.log.Error("record trigger state failed", "trigger", t.TriggerId, "err", err)
	}
	if p.head != nil {
		if err := d.reportConfig(bg, w.runID, *p.head); err != nil {
			d.log.Error("report head config failed", "run", w.runID, "err", err)
		}
	}
	d.drive(ctx, w, run, runner, policy)
	d.client.Flush()
}

// drive submits w's stored run and waits for it to end. A deploy run that
// policy forbids is not submitted: its jobs are skipped.
func (d *Daemon) drive(ctx context.Context, w *work, run store.Run, runner scheduler.JobRunner, policy executor.RunPolicy) {
	bg := context.WithoutCancel(ctx)
	sched := scheduler.New(d.st, runner, scheduler.Options{Slots: d.o.Slots, Logger: d.log})
	defer func() {
		if err := sched.Close(); err != nil {
			d.log.Error("close scheduler failed", "run", w.runID, "err", err)
		}
		if err := d.st.SetTriggerState(bg, w.trig.TriggerId, store.TriggerDone); err != nil {
			d.log.Error("record trigger state failed", "trigger", w.trig.TriggerId, "err", err)
		}
	}()
	if run.Kind == kindDeploy && !policy.AllowDeploy {
		d.skipUntrustedDeploy(bg, run.ID)
		return
	}
	if _, err := sched.Submit(bg, w.runID); err != nil {
		d.log.Error("submit run failed", "run", w.runID, "err", err)
		return
	}
	d.mu.Lock()
	w.sched = sched
	pending := w.interrupted
	d.mu.Unlock()
	if pending != "" {
		d.cancelRun(bg, sched, w.runID, pending)
	}
	if _, err := sched.Wait(ctx, w.runID); err != nil && ctx.Err() == nil {
		d.log.Error("run failed", "run", w.runID, "err", err)
	}
}

// stopped reports whether w's checkout was aborted, by shutdown or by an
// interrupt. An interrupted trigger is reported cancelled; one cut short by
// shutdown stays accepted for the next start to settle.
func (d *Daemon) stopped(ctx context.Context, w *work) bool {
	if ctx.Err() != nil {
		return true
	}
	if w.ctx.Err() == nil {
		return false
	}
	d.mu.Lock()
	reason := w.interrupted
	d.mu.Unlock()
	d.endUnstarted(context.WithoutCancel(ctx), w.trig.TriggerId, w.runID, protocol.EventStateCancelled, reason)
	return true
}

// endUnstarted reports the end of a trigger whose run was never created.
func (d *Daemon) endUnstarted(ctx context.Context, triggerID, runID string, state protocol.EventState, reason string) {
	ev := protocol.Event{State: state}
	if reason != "" {
		ev.Reason = &reason
	}
	if err := sink.NewHub(d.client, runID).Emit(ctx, ev); err != nil {
		d.log.Error("report trigger end failed", "trigger", triggerID, "err", err)
	}
	if err := d.st.SetTriggerState(ctx, triggerID, store.TriggerDone); err != nil {
		d.log.Error("record trigger state failed", "trigger", triggerID, "err", err)
	}
}

func (d *Daemon) reject(ctx context.Context, w *work, reason string, cause error) {
	d.log.Warn("trigger rejected", "trigger", w.trig.TriggerId, "reason", reason, "err", cause)
	if err := d.st.RejectTrigger(ctx, w.trig.TriggerId, reason); err != nil {
		d.log.Error("record rejected trigger failed", "trigger", w.trig.TriggerId, "err", err)
	}
	d.client.Flush()
}

// reportConfig reports a pull request's own .zeroci.yml as the _config job:
// its diagnostics as annotations and success or failed as its state.
func (d *Daemon) reportConfig(ctx context.Context, runID string, diags config.Diagnostics) error {
	hub := sink.NewHub(d.client, runID)
	if err := hub.JobPlanned(ctx, []protocol.JobPlannedJobsElem{{Name: ConfigJob, Needs: []string{}}}); err != nil {
		return err
	}
	if len(diags) > 0 {
		if err := hub.Annotations(ctx, ConfigJob, annotations(diags)); err != nil {
			return err
		}
	}
	state, summary := configSummary(diags)
	job := ConfigJob
	return hub.Emit(ctx, protocol.Event{Job: &job, State: state, Reason: &summary})
}

// recoverTriggers settles the triggers an earlier daemon accepted but did
// not finish. recovery.Recover has already interrupted their running runs; a
// run still queued is cancelled and a trigger without a run is reported
// interrupted.
func (d *Daemon) recoverTriggers(ctx context.Context) error {
	open, err := d.st.ListTriggers(ctx, store.TriggerAccepted, store.TriggerRunning)
	if err != nil {
		return fmt.Errorf("daemon: recover triggers: %w", err)
	}
	for _, t := range open {
		run, err := d.st.GetRun(ctx, t.RunID)
		switch {
		case errors.Is(err, store.ErrNotFound):
			d.endUnstarted(ctx, t.ID, t.RunID, protocol.EventStateInterrupted, recovery.InterruptedReason)
			continue
		case err != nil:
			return fmt.Errorf("daemon: recover trigger %s: %w", t.ID, err)
		case run.State == store.RunQueued:
			if err := d.st.Transition(ctx, run.ID, []store.RunState{store.RunQueued}, store.RunCancelled, recovery.InterruptedReason); err != nil {
				return fmt.Errorf("daemon: recover trigger %s: %w", t.ID, err)
			}
		}
		if err := d.st.SetTriggerState(ctx, t.ID, store.TriggerDone); err != nil {
			return fmt.Errorf("daemon: recover trigger %s: %w", t.ID, err)
		}
	}
	return nil
}

func (d *Daemon) flushLoop(ctx context.Context) {
	t := d.clk.NewTicker(flushInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C():
			d.client.Flush()
		}
	}
}

// storeRun is the stored run of trigger t checked out at sha.
func storeRun(t protocol.Trigger, runID, sha string) store.Run {
	r := store.Run{
		ID:          runID,
		Repo:        t.Repo,
		SHA:         sha,
		Ref:         t.Ref,
		Event:       string(protocol.TriggerEventPush),
		Attempt:     t.Attempt,
		Kind:        "check",
		TrustDomain: string(t.Trust) + ":" + t.Repo,
		TriggerID:   t.TriggerId,
	}
	if t.Pr != nil {
		r.Event = string(protocol.TriggerEventPullRequest)
		n := t.Pr.Number
		r.PR = &n
	}
	if t.BaseSha != nil {
		r.BaseSHA = *t.BaseSha
	}
	return r
}

func storeJobs(checks *config.ResolvedChecks) []store.Job {
	jobs := make([]store.Job, 0, len(checks.Jobs))
	for _, j := range checks.Jobs {
		jobs = append(jobs, store.Job{Name: j.Name, Needs: j.Needs})
	}
	return jobs
}
