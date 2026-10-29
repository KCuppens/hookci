// Package daemon is hookci agent: it keeps the hub session open, checks out
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
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/KCuppens/hookci/agent/internal/agentconf"
	"github.com/KCuppens/hookci/agent/internal/cache"
	"github.com/KCuppens/hookci/agent/internal/capacity"
	"github.com/KCuppens/hookci/agent/internal/clock"
	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/control"
	"github.com/KCuppens/hookci/agent/internal/deploy"
	"github.com/KCuppens/hookci/agent/internal/deploy/trigger"
	"github.com/KCuppens/hookci/agent/internal/executor"
	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/gc"
	"github.com/KCuppens/hookci/agent/internal/hubclient"
	"github.com/KCuppens/hookci/agent/internal/hubtokens"
	"github.com/KCuppens/hookci/agent/internal/ids"
	"github.com/KCuppens/hookci/agent/internal/logtail"
	"github.com/KCuppens/hookci/agent/internal/logupload"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/recovery"
	"github.com/KCuppens/hookci/agent/internal/scheduler"
	"github.com/KCuppens/hookci/agent/internal/sink"
	"github.com/KCuppens/hookci/agent/internal/source"
	"github.com/KCuppens/hookci/agent/internal/store"
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
// already resolved, held to policy. cacheFallback is the branches, in
// order, whose caches the run restores after its own (for a pull request,
// instead of it): the pull request's base, then the repo's default branch.
type ExecutorFunc func(co source.Checkout, checks *config.ResolvedChecks, policy executor.RunPolicy, cacheFallback []string) (scheduler.JobRunner, error)

// Options configures a Daemon.
type Options struct {
	StateDir string
	Version  string
	// OSRelease is the host operating system sent in hello; "" omits it.
	OSRelease string
	Dialer    hubclient.Dialer // nil: real websocket dialer
	Clock     clock.Clock      // nil: real clock
	Logger    *slog.Logger     // nil: discard
	// Source checks runs out; nil fetches from GitHub with hub-issued tokens.
	Source  source.Source
	JobUser executor.JobUser
	Slots   int // job slots of a run; <= 0 means scheduler.DefaultSlots()
	// Pool admits the setup and jobs of every run, across lanes; nil
	// admits everything.
	Pool *capacity.Pool
	// BudgetDefault is the budget from flags and environment: what Pool
	// holds when the hub has set no override.
	BudgetDefault Budget
	// Cache is the setup step cache the executor uses; GC evicts its
	// entries. nil: GC leaves <state>/cache alone.
	Cache *cache.Cache
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
	// HubInfo reads the hub's /v1/info when the daemon starts; nil fetches
	// it from the paired hub.
	HubInfo func(ctx context.Context) (hubclient.HubInfo, error)
}

// Daemon runs the hub's triggers one at a time per lane (a branch's
// pushes, or one pull request), lanes side by side up to its CPU-budget
// lane cap, push to the default branch and to "staging" ahead of
// everything else, each tier oldest first. See Daemon.pick.
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
	tail    *logtail.Tailer // live log tail of the log viewer
	// selfHosted is whether the hub reported mode self_hosted, which lets
	// a .hookci.yml without deployments declare trust: all.
	selfHosted atomic.Bool

	wake    chan struct{}
	mu      sync.Mutex
	queue   []*work // accepted, not started
	running []*work // taken by the worker, one per lane

	deploys     DeployIntake
	deployWake  chan struct{}
	deployQ     []queuedDeploy    // guarded by mu
	deploying   map[string]bool   // trigger ids queued, being decided or waiting to retry; guarded by mu
	deploySched *deploy.Scheduler // runs accepted deploy runs
	// deployRefs returns the GitHub client of a deploy run.
	deployRefs func(run store.DeployRun) *trigger.GitHubRefChecker
	// deployConfig loads the trusted .hookci.yml at a deploy run's sha.
	deployConfig func(context.Context, store.DeployRun) (*config.Config, error)
	collector    *gc.Collector // removes old deploy images and run dirs
	// changes returns the GitHub client that lists the files a check run
	// changes, for job paths.
	changes func(runID string) deploy.ChangeLister
}

// work is one accepted trigger.
type work struct {
	trig  protocol.Trigger
	runID string
	lane  string // scheduler.SupersedeKey of its run
	// retry: runID is the queued retry recovery stored for the trigger's
	// interrupted run, so the run exists before the worker takes it.
	retry bool

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
	if o.HubInfo == nil {
		hubURL := conf.HubURL
		o.HubInfo = func(ctx context.Context) (hubclient.HubInfo, error) {
			return hubclient.FetchInfo(ctx, http.DefaultClient, hubURL)
		}
	}
	d := &Daemon{
		agentID: conf.AgentID, st: st, exec: exec, o: o, clk: o.Clock, log: o.Logger, wake: make(chan struct{}, 1),
		deploys: o.Deploys, deployWake: make(chan struct{}, 1), deploying: map[string]bool{},
	}
	d.selfHosted.Store(conf.HubMode == hubModeSelfHosted)
	credential := conf.Credential
	d.logs = &logupload.Uploader{HubURL: conf.HubURL, Token: func() string { return credential }}
	var capSource hubclient.CapacitySource
	if o.Pool != nil {
		capSource = o.Pool
		saved, err := loadBudgetOverride(o.StateDir)
		if err != nil {
			o.Logger.Warn("ignoring the saved budget override", "err", err)
		}
		b := saved.budget(o.BudgetDefault)
		o.Pool.SetBudget(b.CPUs, b.MemoryBytes)
	}
	d.client = hubclient.New(hubclient.Config{
		HubURL:     conf.HubURL,
		AgentID:    conf.AgentID,
		Credential: conf.Credential,
		Version:    o.Version,
		OSRelease:  o.OSRelease,
		Dialer:     o.Dialer,
		Clock:      o.Clock,
		Capacity:   capSource,
	}, st, d, o.Logger)
	d.tokens = hubtokens.New(d.client, o.Clock)
	d.tail = logtail.NewTailer(filepath.Join(o.StateDir, "runs"), logupload.Redact, d.client.SendLog)
	d.tail.Finished = d.jobFinished
	d.src = o.Source
	if d.src == nil {
		d.src = &source.HubSource{Tokens: d.tokens.Request, WorkRoot: filepath.Join(o.StateDir, "work")}
	}
	github := &http.Client{Timeout: githubTimeout}
	if d.deploys == nil {
		d.deploys = &hubIntake{
			base:   trigger.Intake{Store: st, Clock: o.Clock.Now, NewRunID: ids.NewRunID},
			http:   github,
			tokens: d.tokens.Request,
		}
	}
	d.deployRefs = githubRefs("", github, d.tokens.Request)
	d.changes = func(runID string) deploy.ChangeLister {
		return githubRefs("", github, d.tokens.Request)(store.DeployRun{RunID: runID})
	}
	d.deployConfig = githubConfig(d.deployRefs)
	d.deploySched = d.newDeployScheduler(credential, conf.AgentConfig, hubDeployEvents{client: d.client, log: o.Logger})
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
		d.log.Error("control socket unavailable; hookci gc and retry will not reach this agent", "err", err)
	} else {
		ctl.Handle("gc", d.collector.HandleControl)
		ctl.Handle(deploy.RetryOp, deploy.RetryControl(d.st, d.deploySched))
		wg.Go(func() {
			if err := ctl.Serve(wctx); err != nil {
				d.log.Error("control socket stopped", "err", err)
			}
		})
	}
	wg.Go(func() { d.refreshHubMode(wctx) })
	if d.o.Pool != nil {
		wg.Go(func() { d.o.Pool.Run(wctx) })
	}
	wg.Go(func() { d.worker(wctx) })
	wg.Go(func() { d.flushLoop(wctx) })
	wg.Go(func() { d.deployWorker(wctx) })
	wg.Go(func() { d.deploySched.Run(wctx) })
	wg.Go(func() { d.tail.Run(wctx) })
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

// TokenRefused implements hubclient.TokenRefusals: the hub refused the
// token for runID, a run or deploy trigger, so the requests waiting on it
// fail now instead of timing out.
func (d *Daemon) TokenRefused(runID, message string) bool {
	return d.tokens.Refuse(runID, message)
}

// HandleLive implements hubclient.LiveHandler: the hub opens and closes live
// log tails for its log viewer. A refused subscription leaves the viewer
// without live lines; the uploaded log still shows once the job ends.
func (d *Daemon) HandleLive(f protocol.Frame) {
	switch v := f.(type) {
	case protocol.LogSubscribe:
		if err := d.tail.Subscribe(v.RunId, v.Job, int64(v.Offset)); err != nil {
			d.log.Warn("log tail refused", "run", v.RunId, "job", v.Job, "err", err)
		}
	case protocol.LogUnsubscribe:
		d.tail.Unsubscribe(v.RunId, v.Job)
	}
}

// SessionEnded implements hubclient.LiveHandler: the live log tails were
// opened on the session that ended.
func (d *Daemon) SessionEnded() { d.tail.UnsubscribeAll() }

// jobFinished reports whether job of runID has ended, so its log file is
// complete. A job the store does not know will never write a log; one the
// store cannot be asked about is taken as running until a later poll.
func (d *Daemon) jobFinished(runID, job string) bool {
	jobs, err := d.st.Jobs(context.Background(), runID)
	if err != nil {
		return false
	}
	for _, j := range jobs {
		if j.Name == job {
			return j.State.Terminal()
		}
	}
	return true
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
	d.queue = append(d.queue, &work{trig: t, runID: runID, lane: lane(t)})
	d.mu.Unlock()
	d.kick()
	return nil
}

// lane is the key of t's lane: triggers of one lane run one at a time.
func lane(t protocol.Trigger) string {
	return scheduler.SupersedeKey(storeRun(t, "", ""))
}

func (d *Daemon) kick() {
	select {
	case d.wake <- struct{}{}:
	default:
	}
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
		d.cancelUnstarted(ctx, w, reason)
		return
	}
	i := slices.IndexFunc(d.running, match)
	if i < 0 || d.running[i].interrupted != "" {
		d.mu.Unlock()
		return
	}
	w := d.running[i]
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

// worker starts each lane's triggers in order, one at a time per lane, and
// waits for them all once ctx ends.
func (d *Daemon) worker(ctx context.Context) {
	var wg sync.WaitGroup
	defer wg.Wait()
	for {
		w := d.next(ctx)
		if w == nil {
			return
		}
		wg.Go(func() {
			d.process(ctx, w)
			w.cancel()
			d.mu.Lock()
			d.running = slices.DeleteFunc(d.running, func(r *work) bool { return r == w })
			d.mu.Unlock()
			d.kick()
		})
	}
}

// next takes the best startable queued trigger, or returns nil once ctx
// ends. See Daemon.pick for the selection.
func (d *Daemon) next(ctx context.Context) *work {
	for {
		if ctx.Err() != nil {
			return nil
		}
		d.mu.Lock()
		w := d.pick()
		if w != nil {
			w.ctx, w.cancel = context.WithCancel(ctx)
			d.running = append(d.running, w)
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

// pick returns the best startable queued trigger, or nil when none can
// start right now. d.mu must be held; pick removes the chosen trigger from
// d.queue; callers only add it to d.running.
//
// A trigger may start when its lane is idle, it is under the lane cap
// (maxLanes), and every running trigger has its trust: check jobs of all
// runs share one job user and no PID namespace, so an untrusted run must
// never overlap a trusted one. The scan stops at the first trigger trust
// holds back rather than skipping it for a lower-priority one that is
// startable, so the running side drains and that trigger goes next instead
// of waiting forever.
//
// Among triggers reachable before that stop, push to the repo's default
// branch goes first, then push to "staging", then everything else
// (priority); ties keep arrival order.
func (d *Daemon) pick() *work {
	if laneCap := d.maxLanes(); laneCap > 0 && len(d.running) >= laneCap {
		return nil
	}
	var best *work
	bestIdx := -1
	for i, w := range d.queue {
		if slices.ContainsFunc(d.running, func(r *work) bool { return trusted(r) != trusted(w) }) {
			break
		}
		if slices.ContainsFunc(d.running, func(r *work) bool { return r.lane == w.lane }) {
			continue
		}
		if best == nil || priority(w.trig) < priority(best.trig) {
			best, bestIdx = w, i
		}
	}
	if best == nil {
		return nil
	}
	d.queue = slices.Delete(d.queue, bestIdx, bestIdx+1)
	return best
}

// maxLanes caps how many lanes may run at once, derived from the CPU
// budget: every lane's setup or job claims at least config.DefaultJobCPUs,
// so admitting more lanes than the budget covers only thins each grant
// (capacity.Pool.rebalance) without doing more work sooner. 0 means no cap
// (Options.Pool is nil: "nil admits everything").
func (d *Daemon) maxLanes() int {
	if d.o.Pool == nil {
		return 0
	}
	budget := d.o.Pool.Snapshot().BudgetCPUs
	if budget <= 0 {
		return 0
	}
	if n := int(budget / config.DefaultJobCPUs); n > 0 {
		return n
	}
	return 1
}

// priority ranks t for pick: push to the repo's default branch runs first,
// then push to "staging", then everything else (pull requests, other
// branches, retries of either). Lower runs first.
func priority(t protocol.Trigger) int {
	if t.Pr != nil {
		return 2
	}
	branch := strings.TrimPrefix(t.Ref, "refs/heads/")
	switch {
	case t.DefaultBranch != nil && branch == *t.DefaultBranch:
		return 0
	case branch == "staging":
		return 1
	default:
		return 2
	}
}

// trusted reports whether w runs under the trusted policy (optionsForTrust).
func trusted(w *work) bool { return w.trig.Trust == protocol.TriggerTrustTrusted }

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

	p, err := resolvePlan(co, config.ParseOptions{SelfHosted: d.selfHosted.Load()})
	if err == nil && p.policy != nil && defaultBranchPush(t) {
		// The hub forwards pushes of every branch; only the default
		// branch's configuration is the one fork pull requests are judged by.
		if err := d.st.SaveRepoConfig(bg, t.Repo, co.SHA, string(p.policy.Trust), p.policy.HasDeployments); err != nil {
			d.log.Error("record repo config failed", "repo", t.Repo, "err", err)
		}
	}
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
	inner, err := d.exec(co, p.checks, policy, cacheFallback(t))
	if err != nil {
		discard()
		d.reject(bg, w, ReasonAgentError, err)
		return
	}
	runner := &logRunner{JobRunner: inner, st: d.st, up: d.logs, runDir: dir.Root, local: p.checks.LogsLocal, log: d.log}

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
	run, err := d.startRun(bg, w, co.SHA, p)
	if err != nil {
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
	d.drive(ctx, w, run, runner, policy, p.checks, d.jobSkipper(w, p.checks))
	d.client.Flush()
}

// drive submits w's stored run and waits for it to end. A deploy run that
// policy forbids is not submitted: its jobs are skipped.
func (d *Daemon) drive(ctx context.Context, w *work, run store.Run, runner scheduler.JobRunner, policy executor.RunPolicy, checks *config.ResolvedChecks, skip func(store.Run, string) (string, bool)) {
	bg := context.WithoutCancel(ctx)
	sched := scheduler.New(d.st, runner, scheduler.Options{Slots: d.o.Slots, Logger: d.log, Pool: d.o.Pool, Demand: jobDemand(run, checks), Skip: skip})
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

// jobDemand is what each unit of run asks of the capacity pool: a job its
// effective limits, the setup (job "") the check-level ones. A job's CPUs are
// its guaranteed minimum and its MaxCPUs what idle budget CPU may lend it,
// the whole budget when the config sets no max_cpus; the setup is never
// lent CPU. nil checks ask for nothing.
func jobDemand(run store.Run, checks *config.ResolvedChecks) func(job string) capacity.Demand {
	if checks == nil {
		return nil
	}
	return func(name string) capacity.Demand {
		var job config.ResolvedJob
		if i := slices.IndexFunc(checks.Jobs, func(j config.ResolvedJob) bool { return j.Name == name }); i >= 0 {
			job = checks.Jobs[i]
		}
		l := executor.EffectiveLimits(run, checks.Limits, job)
		d := capacity.Demand{CPUs: l.CPUs, MemoryBytes: l.MemoryBytes}
		if name != "" {
			d.MaxCPUs = l.MaxCPUs
			if d.MaxCPUs <= 0 {
				d.MaxCPUs = capacity.WholeBudget
			}
		}
		return d
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
	d.cancelUnstarted(context.WithoutCancel(ctx), w, reason)
	return true
}

// startRun returns the stored run of w checked out at sha: a retry's run
// is already stored, any other is created from w's trigger and p.
func (d *Daemon) startRun(ctx context.Context, w *work, sha string, p plan) (store.Run, error) {
	if w.retry {
		return d.st.GetRun(ctx, w.runID)
	}
	run := storeRun(w.trig, w.runID, sha)
	run.Slack = p.slack
	return run, d.st.CreateRun(ctx, run, storeJobs(p.checks))
}

// defaultBranchPush reports whether t is a push to the repo's default
// branch. Retries carry no default branch, so they are never one.
func defaultBranchPush(t protocol.Trigger) bool {
	return t.Pr == nil && t.DefaultBranch != nil && t.Ref == "refs/heads/"+*t.DefaultBranch
}

// cacheFallback is the branches whose caches a run of t restores when its
// own branch has none, in order: a pull request's base, then the default
// branch. Retries carry neither, so they restore from their own branch only.
func cacheFallback(t protocol.Trigger) []string {
	var branches []string
	if t.Pr != nil && t.Pr.BaseRef != nil {
		branches = append(branches, *t.Pr.BaseRef)
	}
	if t.DefaultBranch != nil {
		branches = append(branches, *t.DefaultBranch)
	}
	return branches
}

// cancelUnstarted reports w cancelled with reason before its run started.
// A retry's run is already stored, so the store cancels it and reports that.
func (d *Daemon) cancelUnstarted(ctx context.Context, w *work, reason string) {
	if !w.retry {
		d.endUnstarted(ctx, w.trig.TriggerId, w.runID, protocol.EventStateCancelled, reason)
		return
	}
	if err := d.st.Transition(ctx, w.runID, []store.RunState{store.RunQueued}, store.RunCancelled, reason); err != nil {
		d.log.Error("cancel retry run failed", "run", w.runID, "err", err)
	}
	if err := d.st.SetTriggerState(ctx, w.trig.TriggerId, store.TriggerDone); err != nil {
		d.log.Error("record trigger state failed", "trigger", w.trig.TriggerId, "err", err)
	}
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

// reject reports that w's trigger cannot run. The hub has already been told
// a retry's run, so that run is cancelled with reason instead.
func (d *Daemon) reject(ctx context.Context, w *work, reason string, cause error) {
	d.log.Warn("trigger rejected", "trigger", w.trig.TriggerId, "reason", reason, "err", cause)
	if w.retry {
		d.cancelUnstarted(ctx, w, reason)
	} else if err := d.st.RejectTrigger(ctx, w.trig.TriggerId, reason); err != nil {
		d.log.Error("record rejected trigger failed", "trigger", w.trig.TriggerId, "err", err)
	}
	d.client.Flush()
}

// reportConfig reports a pull request's own .hookci.yml as the _config job:
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
// not finish. recovery.Recover has already interrupted their running runs
// and pointed a trigger whose check it re-queued at the retry; that retry is
// queued to run again. Any other run still queued is cancelled and a
// trigger without a run is reported interrupted.
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
		case run.State == store.RunQueued && run.RetryOf != nil:
			d.mu.Lock()
			d.queue = append(d.queue, &work{trig: retryTrigger(run), runID: run.ID, retry: true, lane: scheduler.SupersedeKey(run)})
			d.mu.Unlock()
			continue
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

// retryTrigger rebuilds the trigger of retry, a stored retry of a hub check.
// The fields the run does not keep (the pull request's head details, the
// hub sequence numbers) are not used to run it.
func retryTrigger(retry store.Run) protocol.Trigger {
	trust, _, _ := strings.Cut(retry.TrustDomain, ":")
	t := protocol.Trigger{
		TriggerId: retry.TriggerID,
		Repo:      retry.Repo,
		Sha:       retry.SHA,
		Ref:       retry.Ref,
		Event:     protocol.TriggerEvent(retry.Event),
		Attempt:   retry.Attempt,
		Trust:     protocol.TriggerTrust(trust),
	}
	if retry.PR != nil {
		t.Pr = &protocol.TriggerPr{Number: *retry.PR}
	}
	if retry.BaseSHA != "" {
		base := retry.BaseSHA
		t.BaseSha = &base
	}
	return t
}

// storeJobs plans checks' jobs behind the setup job.
func storeJobs(checks *config.ResolvedChecks) []store.Job {
	jobs := make([]store.Job, 0, len(checks.Jobs))
	for _, j := range checks.Jobs {
		jobs = append(jobs, store.Job{Name: j.Name, Needs: j.Needs})
	}
	return store.WithSetup(jobs)
}
