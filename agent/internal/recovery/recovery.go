// Package recovery cleans up after an agent that was killed mid-run. Recover
// runs once at agent start, before any new run: it stops the leftover job
// units, kills the pasta processes and removes the network namespaces and
// service containers of runs in this agent's store, then moves the runs that
// were in flight to interrupted and re-queues their checks. Resources of runs
// the store does not know, such as another agent's on the same host, are left
// alone.
package recovery

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/isolation"
	"github.com/KCuppens/hookci/agent/internal/netns"
	"github.com/KCuppens/hookci/agent/internal/services"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// MaxCheckAttempts caps how often a check run is started. An interrupted hub
// check on a lower attempt is re-queued as the next attempt, which takes over
// its trigger; the daemon runs it once recovery is done.
const MaxCheckAttempts = 3

// InterruptedReason is recorded on every run and job recovery interrupts.
const InterruptedReason = "agent restarted"

const (
	kindCheck = "check"
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
		RunIDs(ctx context.Context) ([]string, error)
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

// ListNamespaces returns the hci- namespaces the manager sees.
func (m NetnsManager) ListNamespaces(context.Context) ([]string, error) {
	return m.Manager.ListNamespaces()
}

// Recover sweeps the leftover units, pasta processes, namespaces and service
// containers of every run in the store, then interrupts the runs that were
// active. It stops processes before it touches run state, so an interrupted
// run has nothing left running. Cleanup failures go to Report.Errors and the
// log; only store errors are returned, along with the report so far.
func Recover(ctx context.Context, d Deps) (Report, error) {
	log := d.Logger
	if log == nil {
		log = slog.Default()
	}
	var rep Report
	owned, err := d.Store.RunIDs(ctx)
	if err != nil {
		return rep, fmt.Errorf("recovery: list runs: %w", err)
	}
	sweep(ctx, d, owned, &rep, log)
	err = interrupt(ctx, d, &rep, log)
	return rep, err
}

// sweep removes what the owned runs left behind. Units, namespaces and
// containers are matched by the run ID encoded in their name or label, so
// only resources of stored runs are touched.
func sweep(ctx context.Context, d Deps, owned map[string]bool, rep *Report, log *slog.Logger) {
	ctx, cancel := context.WithTimeout(ctx, sweepTimeout)
	defer cancel()
	fail := func(err error) {
		log.Warn("recovery: cleanup failed", "err", err)
		rep.Errors = append(rep.Errors, err)
	}
	unitRuns := make(map[string]bool, len(owned))
	namespaces := make(map[string]bool, len(owned))
	for id := range owned {
		unitRuns[isolation.SanitizeUnitPart(id)] = true
		namespaces[netns.NSName(id)] = true
	}

	units, err := d.Isolation.ListUnits(ctx, isolation.UnitPrefix)
	if err != nil && !errors.Is(err, isolation.ErrUnsupported) {
		fail(fmt.Errorf("recovery: list units: %w", err))
	}
	for _, u := range units {
		if !ownedUnit(unitRuns, u.Name) {
			continue
		}
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
		if !namespaces[name] {
			continue
		}
		// pkill exits 1 when no process matched.
		err := d.Runner.Run(ctx, execx.Cmd{Name: "pkill", Args: []string{"-f", pastaPattern(name)}})
		var exitErr *execx.ExitError
		if err != nil && !(errors.As(err, &exitErr) && exitErr.Code == 1) {
			fail(fmt.Errorf("recovery: kill pasta of %s: %w", name, err))
		}
		if err := d.Netns.RemoveNamespace(ctx, name); err != nil {
			fail(fmt.Errorf("recovery: remove network namespace %s: %w", name, err))
			continue
		}
		rep.NetnsRemoved = append(rep.NetnsRemoved, name)
	}

	labelled, err := d.Docker.RunIDs(ctx)
	if err != nil {
		if !errors.Is(err, services.ErrDockerMissing) {
			fail(fmt.Errorf("recovery: list service containers: %w", err))
		}
		return
	}
	for _, id := range labelled {
		if !owned[id] {
			continue
		}
		if err := d.Docker.RemoveByLabel(ctx, services.LabelRun+"="+id); err != nil {
			fail(fmt.Errorf("recovery: remove service containers of run %s: %w", id, err))
		}
	}
}

// ownedUnit reports whether unit is named UnitPrefix + <run> + "-" + <job>
// for a sanitized run ID in runs. Job names may hold '-', so every split is
// tried.
func ownedUnit(runs map[string]bool, unit string) bool {
	rest, ok := strings.CutPrefix(unit, isolation.UnitPrefix)
	if !ok {
		return false
	}
	for i := range len(rest) {
		if rest[i] == '-' && runs[rest[:i]] {
			return true
		}
	}
	return false
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
		// A local hookci run has no trigger, so no daemon would ever run its
		// retry.
		retry := run.Kind == kindCheck && run.TriggerID != "" && run.Attempt < MaxCheckAttempts
		created, err := d.Store.InterruptRun(ctx, run.ID, InterruptedReason, retry)
		if err != nil {
			return fmt.Errorf("recovery: interrupt run %s: %w", run.ID, err)
		}
		rep.Interrupted = append(rep.Interrupted, run.ID)
		log.Info("recovery: run interrupted", "run", run.ID, "kind", run.Kind, "was", run.State)
		if retry {
			rep.Requeued = append(rep.Requeued, created.ID)
			log.Info("recovery: check re-queued", "run", run.ID, "retry", created.ID, "attempt", created.Attempt)
		}
	}
	return nil
}

// pastaPattern matches the command line of the pasta serving namespace ns:
// pasta runs with --netns /run/netns/<ns> as its last arguments.
func pastaPattern(ns string) string {
	return "^pasta .* --netns [^ ]*/" + ns + "$"
}
