package deploy

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// Recoverer settles the deploys a stopped agent left mid-flight. Recover
// runs once at agent start, before Scheduler.Recover. Deploys never resume
// on their own: the user retries them.
type Recoverer struct {
	Store  *store.Store
	Runner execx.Runner
	Events EventSink
	Clock  func() time.Time // nil means time.Now
	Logger *slog.Logger     // nil means slog.Default()
}

// Recover stops the leftover deploy units, then moves every Running,
// Verifying or RollingBack deploy run to Interrupted with an error naming
// the step it stopped in and `zeroci retry`, releases its env lock and emits
// its interrupted event. It enqueues nothing and returns the interrupted
// run ids. Only store errors fail it.
func (r *Recoverer) Recover(ctx context.Context) ([]string, error) {
	r.stopUnits(ctx)
	runs, err := r.Store.ListDeployRunsInStates(ctx, store.DeployRunning, store.DeployVerifying, store.DeployRollingBack)
	if err != nil {
		return nil, fmt.Errorf("deploy: recover: %w", err)
	}
	var interrupted []string
	for _, run := range runs {
		steps, err := r.Store.ListSteps(ctx, run.RunID)
		if err != nil {
			return interrupted, fmt.Errorf("deploy: recover %s: %w", run.RunID, err)
		}
		msg := interruptedReason(run.RunID, steps)
		if err := r.Store.SetDeployRunState(ctx, run.RunID, store.DeployInterrupted, msg, r.now()); err != nil {
			return interrupted, fmt.Errorf("deploy: recover: %w", err)
		}
		if err := r.Store.ReleaseEnvLock(ctx, run.Repo, run.Env, run.RunID); err != nil {
			return interrupted, fmt.Errorf("deploy: recover: %w", err)
		}
		job := JobName
		r.Events.DeployEvent(protocol.Event{
			RunId: run.RunID, Job: &job, State: protocol.EventStateInterrupted, Reason: &msg, Tail: []string{msg},
		})
		r.logger().Warn("deploy run interrupted by agent restart", "run_id", run.RunID, "reason", msg)
		interrupted = append(interrupted, run.RunID)
	}
	return interrupted, nil
}

// stopUnits stops every transient deploy unit still loaded. Failures are
// logged: a host without systemd has no units to stop, and the runs must
// still be marked Interrupted.
func (r *Recoverer) stopUnits(ctx context.Context) {
	var out bytes.Buffer
	if err := r.Runner.Run(ctx, execx.Cmd{
		Name: "systemctl", Args: []string{"list-units", "--plain", "--no-legend", isolation.UnitPrefix + "*"}, Stdout: &out,
	}); err != nil {
		r.logger().Error("list leftover deploy units failed", "err", err)
		return
	}
	sc := bufio.NewScanner(&out)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 0 {
			continue
		}
		unit := strings.TrimSuffix(fields[0], ".service")
		if !strings.HasPrefix(unit, isolation.UnitPrefix) || !strings.HasSuffix(unit, "-deploy") {
			continue
		}
		if err := r.Runner.Run(ctx, execx.Cmd{Name: "systemctl", Args: []string{"stop", unit}}); err != nil {
			r.logger().Error("stop leftover deploy unit failed", "unit", unit, "err", err)
		}
	}
}

// interruptedReason names the last step left running or failed, 1-based.
func interruptedReason(runID string, steps []store.DeployStep) string {
	at := "between steps"
	for _, s := range steps {
		if s.Status == store.StepRunning || s.Status == store.StepFailed {
			at = fmt.Sprintf("during step %d %s", s.Index+1, s.Name)
		}
	}
	return fmt.Sprintf("agent restarted %s; run zeroci retry %s", at, runID)
}

func (r *Recoverer) now() time.Time {
	if r.Clock == nil {
		return time.Now()
	}
	return r.Clock()
}

func (r *Recoverer) logger() *slog.Logger {
	if r.Logger == nil {
		return slog.Default()
	}
	return r.Logger
}
