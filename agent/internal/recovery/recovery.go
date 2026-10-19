package recovery

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/netns"
	"github.com/KCuppens/zerocideploy/agent/internal/services"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// InterruptedReason is the error explanation recorded for runs interrupted by crash/reboot.
const InterruptedReason = "agent crashed or was killed"

// Manager handles startup crash recovery for active runs and orphan resources.
type Manager struct {
	store     *store.Store
	isolation isolation.Isolation
	services  *services.Manager
	netns     *netns.Manager
}

// New constructs a crash recovery Manager.
func New(db *store.Store, iso isolation.Isolation, svcs *services.Manager, netnsMgr *netns.Manager) *Manager {
	return &Manager{
		store:     db,
		isolation: iso,
		services:  svcs,
		netns:     netnsMgr,
	}
}

// serviceCleanupBudget bounds all service container cleanup in one Recover call, so a hung
// docker daemon delays startup by at most this long no matter how many runs need recovery.
const serviceCleanupBudget = 30 * time.Second

// Recover scans the database for non-terminal active runs (running, verifying, rolling_back),
// marks them and their unfinished jobs interrupted, and tears down orphan units/containers.
// Returns the list of recovered run IDs. A run whose service containers cannot be removed is
// left in its active state so the next Recover retries it; those failures are joined into the
// returned error and recovery moves on to the next run.
func (m *Manager) Recover(ctx context.Context) ([]string, error) {
	if m.store == nil {
		return nil, nil
	}

	runs, err := m.store.ListRuns(ctx, store.RunFilter{
		States: []store.RunState{store.RunRunning, store.RunVerifying, store.RunRollingBack},
	})
	if err != nil {
		return nil, fmt.Errorf("fetch incomplete runs: %w", err)
	}

	cleanupCtx, cancel := context.WithTimeout(ctx, serviceCleanupBudget)
	defer cancel()

	var recovered []string
	var cleanupErrs []error
	for _, run := range runs {
		// 1. Remove orphan service containers before marking the run, so a failure can be retried
		if m.services != nil {
			if err := m.services.Cleanup(cleanupCtx, run.ID); err != nil {
				cleanupErrs = append(cleanupErrs, fmt.Errorf("run %s left active for retry: %w", run.ID, err))
				continue
			}
		}

		// 2. Mark unfinished jobs as interrupted
		jobs, err := m.store.Jobs(ctx, run.ID)
		if err == nil {
			for _, j := range jobs {
				if j.State == store.JobQueued || j.State == store.JobRunning {
					_ = m.store.TransitionJob(ctx, run.ID, j.Name, []store.JobState{j.State}, store.JobInterrupted,
						store.JobUpdate{Reason: InterruptedReason})
				}
			}
		}

		// 3. Transition run to Interrupted
		if err := m.store.Transition(ctx, run.ID, []store.RunState{run.State}, store.RunInterrupted, InterruptedReason); err != nil {
			transitionErr := fmt.Errorf("transition run %s to interrupted: %w", run.ID, err)
			return recovered, errors.Join(append(cleanupErrs, transitionErr)...)
		}

		// 4. Stop orphan transient units via isolation backend
		if m.isolation != nil {
			_ = m.isolation.Cleanup(ctx, run.ID)
		}

		// 5. Destroy network namespace if present
		if m.netns != nil {
			_ = m.netns.Destroy(ctx, run.ID)
		}
		recovered = append(recovered, run.ID)
	}

	return recovered, errors.Join(cleanupErrs...)
}
