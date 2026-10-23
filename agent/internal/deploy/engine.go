package deploy

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"maps"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/KCuppens/hookci/agent/internal/clock"
	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/redact"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// JobName is the job a deploy run reports in protocol frames.
const JobName = "deploy"

// TailLines is the most run log lines a Failed event carries.
const TailLines = 40

// EventSink receives the protocol frames of deploy runs. It wraps the outbox;
// a send failure is the sink's to handle and never changes a run's outcome.
type EventSink interface {
	DeployPlanned(p protocol.JobPlanned)
	DeployEvent(ev protocol.Event)
}

// Engine runs deploy plans. It persists every step before running it and
// moves the run through Running, Verifying, RollingBack, Success and Failed.
// It takes no locks: the caller makes sure one run per environment runs.
type Engine struct {
	Store      *store.Store
	Strategies map[string]DeployStrategy // keyed by DeployStrategy.Name
	Events     EventSink
	Clock      clock.Clock
	// NewExecutor returns the executor of a run's commands; an error, such
	// as ErrUntrustedDeploy, fails the run before anything is fetched.
	NewExecutor func(ctx context.Context, run store.DeployRun, cfg config.Deployment) (Executor, error)
	// Checkout puts the source of run.SHA where the strategy reads it. Every
	// pass calls it before the first step, so it must reuse a finished
	// checkout of an earlier attempt.
	Checkout func(ctx context.Context, run store.DeployRun) error
	// LoadDeployment returns the deployments.<env> block of the trusted
	// config at run.SHA.
	LoadDeployment func(ctx context.Context, run store.DeployRun) (config.Deployment, error)
	// Preflight runs in order when Start begins a run, before step 0. An
	// error fails the run with the error text as the run error, with no step
	// recorded and no rollback.
	Preflight []PreflightFunc
}

// Start runs runID from step 0. The run must be Queued or Interrupted. It
// returns nil once the run reaches Success or Failed, and an error when the
// outcome could not be recorded or ctx ended first; then the run keeps its
// current state and steps.
func (e *Engine) Start(ctx context.Context, runID string) error {
	run, err := e.loadStartable(ctx, runID)
	if err != nil {
		return err
	}
	x := e.newExecution(run)
	if err := x.transition(ctx, store.DeployRunning, -1); err != nil {
		return err
	}
	x.planned()
	if failed, err := x.preflight(ctx); failed {
		return err
	}
	return x.execute(ctx, 0, map[string]string{})
}

// Resume continues runID at its first step whose status is not done, with
// the merged outputs of the done steps before it, as attempt+1. A step left
// running is run again. The run must be Queued or Interrupted. Errors are as
// for Start.
func (e *Engine) Resume(ctx context.Context, runID string) error {
	run, err := e.loadStartable(ctx, runID)
	if err != nil {
		return err
	}
	steps, err := e.Store.ListSteps(ctx, runID)
	if err != nil {
		return fmt.Errorf("deploy: resume %s: %w", runID, err)
	}
	from, outputs := resumePoint(steps)
	if run.Attempt, err = e.Store.IncrementDeployAttempt(ctx, runID); err != nil {
		return fmt.Errorf("deploy: resume %s: %w", runID, err)
	}
	x := e.newExecution(run)
	if err := x.transition(ctx, store.DeployRunning, -1); err != nil {
		return err
	}
	return x.execute(ctx, from, outputs)
}

// Retry runs runID again after RequestRetry re-queued it, under the attempt
// RequestRetry gave it. A retry of a Failed run resets the steps and runs
// from step 0. A retry of an Interrupted run continues at its first step not
// done, as Resume does, unless a step had failed: then the agent stopped
// during that step's rollback, so Retry first rolls back from that step,
// then resets the steps and runs from step 0. A rollback that fails again
// fails the run. A run not re-queued by a retry yields an error wrapping
// ErrNotRetryable. Other errors are as for Start.
func (e *Engine) Retry(ctx context.Context, runID string) error {
	run, err := e.Store.GetDeployRun(ctx, runID)
	if err != nil {
		return fmt.Errorf("deploy: %w", err)
	}
	if run.State != store.DeployQueued || !Retryable(run.RetryOfState) {
		return fmt.Errorf("deploy: run %s is %s, not a queued retry: %w", runID, run.State, ErrNotRetryable)
	}
	steps, err := e.Store.ListSteps(ctx, runID)
	if err != nil {
		return fmt.Errorf("deploy: retry %s: %w", runID, err)
	}
	retryOf := run.RetryOfState
	run.RetryOfState = ""
	x := e.newExecution(run)
	failed := slices.IndexFunc(steps, func(s store.DeployStep) bool { return s.Status == store.StepFailed })
	if retryOf == store.DeployInterrupted && failed < 0 {
		from, outputs := resumePoint(steps)
		if err := x.begin(ctx, store.DeployRunning, -1); err != nil {
			return err
		}
		return x.execute(ctx, from, outputs)
	}
	if retryOf == store.DeployInterrupted {
		return x.finishRollback(ctx, steps[failed])
	}
	if err := e.Store.ResetSteps(ctx, runID); err != nil {
		return fmt.Errorf("deploy: %w", err)
	}
	if err := x.begin(ctx, store.DeployRunning, -1); err != nil {
		return err
	}
	x.planned()
	if failed, err := x.preflight(ctx); failed {
		return err
	}
	return x.execute(ctx, 0, map[string]string{})
}

// resumePoint is the index of the first step not done after the contiguous
// done steps from 0, and the merged outputs of those done steps.
func resumePoint(steps []store.DeployStep) (int, map[string]string) {
	outputs := map[string]string{}
	from := 0
	for _, st := range steps {
		if st.Index != from || st.Status != store.StepDone {
			break
		}
		maps.Copy(outputs, st.Outputs)
		from++
	}
	return from, outputs
}

func (e *Engine) loadStartable(ctx context.Context, runID string) (store.DeployRun, error) {
	run, err := e.Store.GetDeployRun(ctx, runID)
	if err != nil {
		return store.DeployRun{}, fmt.Errorf("deploy: %w", err)
	}
	if run.State != store.DeployQueued && run.State != store.DeployInterrupted {
		return store.DeployRun{}, fmt.Errorf("deploy: run %s is %s, want %s or %s",
			runID, run.State, store.DeployQueued, store.DeployInterrupted)
	}
	return run, nil
}

// execution is one engine pass over a run.
type execution struct {
	e       *Engine
	run     store.DeployRun
	state   string
	started time.Time
	steps   []Step
	log     *runLog

	progressMu sync.Mutex
	current    int // index of the planned step that is running, which sub-step events report
}

func (e *Engine) newExecution(run store.DeployRun) *execution {
	return &execution{e: e, run: run, state: run.State, started: e.Clock.Now(), log: newRunLog()}
}

// begin moves a retried run to state, on step when step >= 0, then clears
// its retry mark: the run is no longer Queued, so a restart sees it through
// the Recoverer instead of re-queueing it as a retry.
func (x *execution) begin(ctx context.Context, state string, step int) error {
	if err := x.transition(ctx, state, step); err != nil {
		return err
	}
	return x.clearRetry(ctx)
}

func (x *execution) clearRetry(ctx context.Context) error {
	if err := x.e.Store.ClearRetryOf(ctx, x.run.RunID); err != nil {
		return fmt.Errorf("deploy: %w", err)
	}
	return nil
}

// planned tells the hub the run's one job.
func (x *execution) planned() {
	env := x.run.Env
	x.e.Events.DeployPlanned(protocol.JobPlanned{
		RunId: x.run.RunID,
		Env:   &env,
		Jobs:  []protocol.JobPlannedJobsElem{{Name: JobName, Needs: []string{}}},
	})
}

// preflight runs the Engine's Preflight checks. When one fails it fails the
// run with the check's error text and no step, and reports failed with the
// error of recording that; an error after ctx ended keeps the run as it is.
func (x *execution) preflight(ctx context.Context) (failed bool, err error) {
	for _, check := range x.e.Preflight {
		if err := check(ctx, x.run); err != nil {
			if ctx.Err() != nil {
				return true, fmt.Errorf("deploy: run %s: preflight: %w", x.run.RunID, err)
			}
			return true, x.fail(ctx, err.Error(), -1)
		}
	}
	return false, nil
}

// finishRollback rolls back from failed, the step whose rollback a restart
// cut short, with the outputs recorded when it failed. After it succeeds the
// steps are reset and the run deploys again from step 0; when it fails the
// run fails.
func (x *execution) finishRollback(ctx context.Context, failed store.DeployStep) error {
	e, run := x.e, x.run
	strat, sc, err := x.plan(ctx, maps.Clone(failed.Outputs))
	if sc == nil {
		if err != nil {
			return err
		}
		return x.clearRetry(ctx)
	}
	if sc.Outputs == nil {
		sc.Outputs = map[string]string{}
	}
	if failed.Index >= len(x.steps) {
		if err := x.fail(ctx, fmt.Sprintf("deployments.%s: rollback after restart failed: step %d %s is not in the %d-step plan",
			run.Env, failed.Index+1, failed.Name, len(x.steps)), -1); err != nil {
			return err
		}
		return x.clearRetry(ctx)
	}
	if err := x.begin(ctx, store.DeployRollingBack, failed.Index); err != nil {
		return err
	}
	fmt.Fprintf(x.log, "rolling back step %d/%d %s after restart\n", failed.Index+1, len(x.steps), failed.Name)
	if err := strat.Rollback(ctx, sc, failed.Index); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("deploy: run %s: rollback: %w", run.RunID, err)
		}
		msg := fmt.Sprintf("deployments.%s: rollback after restart failed: %v", run.Env, err)
		fmt.Fprintln(x.log, msg)
		return x.fail(ctx, msg, failed.Index)
	}
	if err := e.Store.ResetSteps(ctx, run.RunID); err != nil {
		return fmt.Errorf("deploy: %w", err)
	}
	if err := x.transition(ctx, store.DeployRunning, -1); err != nil {
		return err
	}
	x.planned()
	sc.Outputs = map[string]string{}
	return x.runFrom(ctx, strat, sc, 0)
}

// execute plans the run and runs its steps from index from.
func (x *execution) execute(ctx context.Context, from int, outputs map[string]string) error {
	strat, sc, err := x.plan(ctx, outputs)
	if sc == nil {
		return err
	}
	return x.runFrom(ctx, strat, sc, from)
}

// plan looks up the strategy and the deployment config and plans the steps.
// A nil StepContext means the run went no further: it was failed, and err is
// nil, or its outcome could not be recorded, and err says why.
func (x *execution) plan(ctx context.Context, outputs map[string]string) (DeployStrategy, *StepContext, error) {
	e, run := x.e, x.run
	strat, ok := e.Strategies[run.Strategy]
	if !ok {
		return nil, nil, x.fail(ctx, fmt.Sprintf("deployments.%s.strategy: %s is not a strategy this agent runs; it runs %s",
			run.Env, run.Strategy, strings.Join(slices.Sorted(maps.Keys(e.Strategies)), ", ")), -1)
	}
	cfg, err := e.LoadDeployment(ctx, run)
	if err != nil {
		if ctx.Err() != nil {
			return nil, nil, fmt.Errorf("deploy: run %s: load config: %w", run.RunID, err)
		}
		return nil, nil, x.fail(ctx, fmt.Sprintf("deployments.%s: load config: %v", run.Env, err), -1)
	}
	if x.steps, err = strat.Plan(run, cfg); err != nil {
		return nil, nil, x.fail(ctx, fmt.Sprintf("deployments.%s: plan %s: %v", run.Env, run.Strategy, err), -1)
	}
	exec, err := e.NewExecutor(ctx, run, cfg)
	if err != nil {
		if ctx.Err() != nil {
			return nil, nil, fmt.Errorf("deploy: run %s: executor: %w", run.RunID, err)
		}
		return nil, nil, x.fail(ctx, fmt.Sprintf("deployments.%s: executor: %v", run.Env, err), -1)
	}
	if m, ok := exec.(maskingExecutor); ok {
		x.log.maskWith(m.Masker())
	}
	if err := e.Checkout(ctx, run); err != nil {
		if ctx.Err() != nil {
			return nil, nil, fmt.Errorf("deploy: run %s: checkout: %w", run.RunID, err)
		}
		return nil, nil, x.fail(ctx, fmt.Sprintf("deployments.%s: checkout %s@%s: %v", run.Env, run.Repo, shortSHA(run.SHA), err), -1)
	}
	return strat, &StepContext{Run: run, Cfg: cfg, Outputs: outputs, Exec: exec, Log: x.log, Clock: e.Clock, Progress: x.progress}, nil
}

// runFrom runs the planned steps from index from.
func (x *execution) runFrom(ctx context.Context, strat DeployStrategy, sc *StepContext, from int) error {
	e, run := x.e, x.run
	for i := from; i < len(x.steps); i++ {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("deploy: run %s: %w", run.RunID, err)
		}
		step := x.steps[i]
		x.progressMu.Lock()
		x.current = i
		x.progressMu.Unlock()
		if err := e.Store.BeginStep(ctx, run.RunID, i, step.Name, maps.Clone(sc.Outputs), e.Clock.Now()); err != nil {
			return fmt.Errorf("deploy: %w", err)
		}
		state := x.state
		if step.Phase == PhaseVerify && state == store.DeployRunning {
			state = store.DeployVerifying
		}
		if err := x.transition(ctx, state, i); err != nil {
			return err
		}
		fmt.Fprintf(x.log, "step %d/%d %s\n", i+1, len(x.steps), step.Name)
		if err := step.Run(ctx, sc); err != nil {
			if ctx.Err() != nil {
				return fmt.Errorf("deploy: run %s: step %s: %w", run.RunID, step.Name, err)
			}
			return x.rollback(ctx, strat, sc, i, err)
		}
		if err := e.Store.FinishStep(ctx, run.RunID, i, store.StepDone, maps.Clone(sc.Outputs), e.Clock.Now()); err != nil {
			return fmt.Errorf("deploy: %w", err)
		}
	}
	return x.succeed(ctx, sc.Outputs)
}

// rollback records step i as failed, runs the strategy rollback and fails
// the run.
func (x *execution) rollback(ctx context.Context, strat DeployStrategy, sc *StepContext, i int, stepErr error) error {
	e, run := x.e, x.run
	if err := e.Store.FinishStep(ctx, run.RunID, i, store.StepFailed, maps.Clone(sc.Outputs), e.Clock.Now()); err != nil {
		return fmt.Errorf("deploy: %w", err)
	}
	msg := fmt.Sprintf("deployments.%s: step %s failed: %v", run.Env, x.steps[i].Name, stepErr)
	fmt.Fprintln(x.log, msg)
	if err := x.transition(ctx, store.DeployRollingBack, i); err != nil {
		return err
	}
	if err := strat.Rollback(ctx, sc, i); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("deploy: run %s: rollback: %w", run.RunID, err)
		}
		fmt.Fprintf(x.log, "rollback failed: %v\n", err)
		msg += "; rollback failed: " + err.Error()
	}
	return x.fail(ctx, msg, i)
}

// fail moves the run to Failed with error msg and emits the log tail. step
// is the failed step index, or -1 when no step ran. msg is masked as the run
// log is, since it can carry command or health check output.
func (x *execution) fail(ctx context.Context, msg string, step int) error {
	msg = x.log.mask(msg)
	if err := x.e.Store.SetDeployRunState(ctx, x.run.RunID, store.DeployFailed, msg, x.e.Clock.Now()); err != nil {
		return fmt.Errorf("deploy: %w", err)
	}
	x.state = store.DeployFailed
	ev := x.event(step)
	ev.Reason = &msg
	ev.DurationMs = x.durationMs()
	ev.Tail = x.log.finish()
	sendStateChange(x.e.Events, ev)
	return nil
}

// succeed records the deployed release in deploy_state, then moves the run
// to Success. A crash in between leaves deploy_state matching what serves.
func (x *execution) succeed(ctx context.Context, outputs map[string]string) error {
	e, run := x.e, x.run
	now := e.Clock.Now()
	if err := e.Store.SetDeployState(ctx, store.DeployState{
		Repo: run.Repo, Env: run.Env, ActiveColor: outputs["color"],
		LastSuccessSHA: run.SHA, LastSuccessRun: run.RunID, UpdatedAt: now,
	}); err != nil {
		return fmt.Errorf("deploy: %w", err)
	}
	if err := e.Store.SetDeployRunState(ctx, run.RunID, store.DeploySuccess, "", now); err != nil {
		return fmt.Errorf("deploy: %w", err)
	}
	x.state = store.DeploySuccess
	x.log.finish()
	ev := x.event(-1)
	ev.DurationMs = x.durationMs()
	sendStateChange(e.Events, ev)
	return nil
}

// transition stores state when it changed and emits an event for it, on
// step when step >= 0. A changed state also goes out as the run's own event.
func (x *execution) transition(ctx context.Context, state string, step int) error {
	if state == x.state {
		x.e.Events.DeployEvent(x.event(step))
		return nil
	}
	if err := x.e.Store.SetDeployRunState(ctx, x.run.RunID, state, "", x.e.Clock.Now()); err != nil {
		return fmt.Errorf("deploy: %w", err)
	}
	x.state = state
	sendStateChange(x.e.Events, x.event(step))
	return nil
}

var eventStates = map[string]protocol.EventState{
	store.DeployRunning:     protocol.EventStateRunning,
	store.DeployVerifying:   protocol.EventStateVerifying,
	store.DeployRollingBack: protocol.EventStateRollingBack,
	store.DeploySuccess:     protocol.EventStateSuccess,
	store.DeployFailed:      protocol.EventStateFailed,
}

// sendStateChange sends ev, the deploy job's event in a new state, then the
// run's own event in that state: the hub moves only the step on job events
// and the run, its check and its badge on run events. The run event carries
// the tail too, since the hub's failure alert reads it there. The job event
// goes first, since the hub ignores job events after the run's terminal one.
func sendStateChange(sink EventSink, ev protocol.Event) {
	sink.DeployEvent(ev)
	sink.DeployEvent(protocol.Event{RunId: ev.RunId, State: ev.State, Reason: ev.Reason, DurationMs: ev.DurationMs, Tail: ev.Tail})
}

// event is the event for the current state, on step when step >= 0. Once
// the run is planned it carries steps_total.
func (x *execution) event(step int) protocol.Event {
	job := JobName
	ev := protocol.Event{RunId: x.run.RunID, Job: &job, State: eventStates[x.state]}
	if x.steps != nil {
		total := len(x.steps)
		ev.StepsTotal = &total
	}
	if step >= 0 {
		name, index := x.steps[step].Name, step
		ev.Step, ev.StepIndex = &name, &index
	}
	return ev
}

// progress emits the event of sub-step name in the current state, on the
// planned step that is running and with steps_total, so the hub shows the
// step's position and the sub-step's name. It may run on a command's output
// goroutine while the step waits for the command.
func (x *execution) progress(name string) {
	x.progressMu.Lock()
	defer x.progressMu.Unlock()
	job, index, total := JobName, x.current, len(x.steps)
	x.e.Events.DeployEvent(protocol.Event{
		RunId: x.run.RunID, Job: &job, State: eventStates[x.state], Step: &name, StepIndex: &index, StepsTotal: &total,
	})
}

func (x *execution) durationMs() *int {
	ms := int(x.e.Clock.Now().Sub(x.started).Milliseconds())
	return &ms
}

// maskingExecutor is an Executor that masks secrets, such as the env_file
// values, in its output. Once the run has one, the run log and the failure
// reason are masked with the same redactor.
type maskingExecutor interface {
	Masker() *redact.Redactor
}

// runLog is the redacted run log. It keeps the last TailLines lines and is
// safe for concurrent writers, such as a command's stdout and stderr.
type runLog struct {
	mu   sync.Mutex
	red  *redact.Redactor
	w    io.WriteCloser // writer into tail, masking with red
	tail lineTail
}

func newRunLog() *runLog {
	l := &runLog{}
	l.red, _ = redact.New(nil, nil) // no literals, so no warnings
	l.w = l.red.Writer(&l.tail)
	return l
}

// maskWith masks later writes and reasons with r. Every write so far ended
// in a newline, so closing the old writer flushes nothing unmasked.
func (l *runLog) maskWith(r *redact.Redactor) {
	l.mu.Lock()
	defer l.mu.Unlock()
	_ = l.w.Close()
	l.red = r
	l.w = r.Writer(&l.tail)
}

// mask returns s with what the log masks replaced by redact.Mask.
func (l *runLog) mask(s string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.red.Line(s)
}

func (l *runLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

// finish closes the log and returns its last lines. Later writes fail.
func (l *runLog) finish() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	_ = l.w.Close() // flushes into tail, which never fails
	if len(l.tail.partial) > 0 {
		l.tail.push(l.tail.partial)
		l.tail.partial = nil
	}
	return l.tail.lines()
}

// lineTail keeps the last TailLines lines written to it in a ring.
type lineTail struct {
	ring    [TailLines]string
	next, n int
	partial []byte
}

func (t *lineTail) Write(p []byte) (int, error) {
	n := len(p)
	for {
		i := bytes.IndexByte(p, '\n')
		if i < 0 {
			t.partial = append(t.partial, p...)
			return n, nil
		}
		t.push(append(t.partial, p[:i]...))
		t.partial = t.partial[:0]
		p = p[i+1:]
	}
}

func (t *lineTail) push(line []byte) {
	t.ring[t.next] = string(bytes.TrimSuffix(line, []byte{'\r'}))
	t.next = (t.next + 1) % TailLines
	t.n = min(t.n+1, TailLines)
}

// lines returns the kept lines, oldest first.
func (t *lineTail) lines() []string {
	out := make([]string, 0, t.n)
	for i := range t.n {
		out = append(out, t.ring[(t.next-t.n+i+TailLines)%TailLines])
	}
	return out
}
