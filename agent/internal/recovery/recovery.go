// Package recovery cleans up after an agent that was killed mid-run. Recover
// runs once at agent start, before any new run: it stops every leftover job
// unit, removes every zc- network namespace, kills stray pasta processes and
// removes every service container, then moves the runs that were in flight to
// interrupted and re-queues their checks.
package recovery

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/netns"
	"github.com/KCuppens/zerocideploy/agent/internal/services"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// MaxCheckAttempts caps how often a check run is started. An interrupted check
// on a lower attempt is re-queued as the next attempt.
const MaxCheckAttempts = 3

// InterruptedReason is recorded on every run and job recovery interrupts.
const InterruptedReason = "agent restarted"

const (
	kindCheck    = "check"
	netnsPrefix  = "zc-"
	pastaPattern = "^pasta .*zc-"
	// sweepTimeout bounds the cleanup sweep so a hung docker daemon or
	// systemctl cannot stall agent start.
	sweepTimeout = 30 * time.Second
)

// Deps are the resources Recover cleans up. Logger may be nil, which means
// slog.Default().
type Deps struct {
	Store     *store.Store
	Isolation isolation.Isolation
	Netns     interface {
		ListNamespaces(ctx context.Context) ([]string, error)
		RemoveNamespace(ctx context.Context, name string) error
	}
	Docker interface {
		RemoveByLabel(ctx context.Context, label string) error
	}
	Runner execx.Runner // runs pkill for stray pasta processes
	Logger *slog.Logger
}

// Report lists what Recover did. Interrupted holds the IDs of the runs it
// interrupted and Requeued the IDs of the retries it created. Errors holds the
// cleanup failures; the next start sweeps again.
type Report struct {
	UnitsStopped []string
	NetnsRemoved []string
	Interrupted  []string
	Requeued     []string
	Errors       []error
}

// NetnsManager adapts *netns.Manager, whose ListNamespaces takes no context,
// to Deps.Netns.
type NetnsManager struct{ *netns.Manager }

// ListNamespaces returns the zc- namespaces the manager sees.
func (m NetnsManager) ListNamespaces(context.Context) ([]string, error) {
	return m.Manager.ListNamespaces()
}

// Recover sweeps every leftover unit, namespace, pasta process and service
// container, then interrupts the runs that were active. It stops processes
// before it touches run state, so an interrupted run has nothing left running.
// Cleanup failures go to Report.Errors and the log; only store errors are
// returned, along with the report so far.
func Recover(ctx context.Context, d Deps) (Report, error) {
	log := d.Logger
	if log == nil {
		log = slog.Default()
	}
	var rep Report
	sweep(ctx, d, &rep, log)
	err := interrupt(ctx, d, &rep, log)
	return rep, err
}

func sweep(ctx context.Context, d Deps, rep *Report, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(ctx, sweepTimeout)
	defer cancel()
	fail := func(err error) {
		log.Warn("recovery: cleanup failed", "err", err)
		rep.Errors = append(rep.Errors, err)
	}

	units, err := d.Isolation.ListUnits(ctx, isolation.UnitPrefix)
	if err != nil && !errors.Is(err, isolation.ErrUnsupported) {
		fail(fmt.Errorf("recovery: list units: %w", err))
	}
	for _, u := range units {
		if err := d.Isolation.Stop(ctx, u.Name); err != nil {
			fail(fmt.Errorf("recovery: stop unit %s: %w", u.Name, err))
			continue
		}
		rep.UnitsStopped = append(rep.UnitsStopped, u.Name)
	}

	names, err := d.Netns.ListNamespaces(ctx)
	if err != nil {
		fail(fmt.Errorf("recovery: list network namespaces: %w", err))
	}
	for _, name := range names {
		if !strings.HasPrefix(name, netnsPrefix) {
			continue
		}
		if err := d.Netns.RemoveNamespace(ctx, name); err != nil {
			fail(fmt.Errorf("recovery: remove network namespace %s: %w", name, err))
			continue
		}
		rep.NetnsRemoved = append(rep.NetnsRemoved, name)
	}

	// pkill exits 1 when no process matched.
	err = d.Runner.Run(ctx, execx.Cmd{Name: "pkill", Args: []string{"-f", pastaPattern}})
	var exitErr *execx.ExitError
	if err != nil && !(errors.As(err, &exitErr) && exitErr.Code == 1) {
		fail(fmt.Errorf("recovery: kill pasta: %w", err))
	}

	if err := d.Docker.RemoveByLabel(ctx, services.LabelRun); err != nil && !errors.Is(err, services.ErrDockerMissing) {
		fail(fmt.Errorf("recovery: remove service containers: %w", err))
	}
}

func interrupt(ctx context.Context, d Deps, rep *Report, log *slog.Logger) error {
	runs, err := d.Store.ListRuns(ctx, store.RunFilter{
		States: []store.RunState{store.RunRunning, store.RunVerifying, store.RunRollingBack},
	})
	if err != nil {
		return fmt.Errorf("recovery: list active runs: %w", err)
	}
	slices.Reverse(runs) // oldest first, so retries queue in the original order

	for _, run := range runs {
		jobs, err := d.Store.Jobs(ctx, run.ID)
		if err != nil {
			return fmt.Errorf("recovery: run %s: %w", run.ID, err)
		}
		for _, j := range jobs {
			if j.State != store.JobQueued && j.State != store.JobRunning {
				continue
			}
			err := d.Store.TransitionJob(ctx, run.ID, j.Name, []store.JobState{j.State}, store.JobInterrupted,
				store.JobUpdate{Reason: InterruptedReason})
			if err != nil {
				return fmt.Errorf("recovery: interrupt job %s of run %s: %w", j.Name, run.ID, err)
			}
		}
		if err := d.Store.Transition(ctx, run.ID, []store.RunState{run.State}, store.RunInterrupted, InterruptedReason); err != nil {
			return fmt.Errorf("recovery: interrupt run %s: %w", run.ID, err)
		}
		rep.Interrupted = append(rep.Interrupted, run.ID)
		log.Info("recovery: run interrupted", "run", run.ID, "kind", run.Kind, "was", run.State)

		if run.Kind != kindCheck || run.Attempt >= MaxCheckAttempts {
			continue
		}
		retry, err := d.Store.CreateRetry(ctx, run.ID)
		if err != nil {
			return fmt.Errorf("recovery: re-queue run %s: %w", run.ID, err)
		}
		rep.Requeued = append(rep.Requeued, retry.ID)
		log.Info("recovery: check re-queued", "run", run.ID, "retry", retry.ID, "attempt", retry.Attempt)
	}
	return nil
}
