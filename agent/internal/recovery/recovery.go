package recovery

import (
	"context"
	"fmt"

	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
	"github.com/KCuppens/zerocideploy/agent/internal/netns"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/services"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// InterruptedReason is the error explanation recorded for runs interrupted by crash/reboot.
const InterruptedReason = "agent crashed or was killed"

// Manager handles startup crash recovery for active runs and orphan resources.
type Manager struct {
	store     *store.DB
	isolation isolation.Isolation
	services  *services.Manager
	netns     *netns.Manager
}

// New constructs a crash recovery Manager.
func New(db *store.DB, iso isolation.Isolation, svcs *services.Manager, netnsMgr *netns.Manager) *Manager {
	return &Manager{
		store:     db,
		isolation: iso,
		services:  svcs,
		netns:     netnsMgr,
	}
}

// Recover scans the database for non-terminal active runs (Running, Verifying, RollingBack),
// marks them as Interrupted, cancels/fails any running jobs, and tears down orphan units/containers.
// Returns the list of recovered run IDs.
func (m *Manager) Recover(ctx context.Context) ([]string, error) {
	if m.store == nil {
		return nil, nil
	}

	runs, err := m.store.GetIncompleteRuns(ctx)
	if err != nil {
		return nil, fmt.Errorf("fetch incomplete runs: %w", err)
	}

	var recovered []string
	for _, run := range runs {
		// 1. Mark unfinished jobs as failed
		jobs, err := m.store.ListJobs(ctx, run.ID)
		if err == nil {
			for _, j := range jobs {
				if j.State == protocol.JobStateQueued || j.State == protocol.JobStateRunning {
					targetState := protocol.JobStateCancelled
					if j.State == protocol.JobStateRunning {
						targetState = protocol.JobStateFailed
					}
					exitCode := 137 // SIGKILL indicator
					_ = m.store.TransitionJob(ctx, run.ID, j.Name, j.State, targetState, &exitCode, InterruptedReason)
				}
			}
		}

		// 2. Transition run to Interrupted
		if err := m.store.TransitionRun(ctx, run.ID, run.State, protocol.RunStateInterrupted, InterruptedReason); err != nil {
			return recovered, fmt.Errorf("transition run %s to interrupted: %w", run.ID, err)
		}

		// 3. Stop orphan transient units via isolation backend
		if m.isolation != nil {
			_ = m.isolation.Cleanup(ctx, run.ID)
		}

		// 4. Destroy network namespace if present
		if m.netns != nil {
			_ = m.netns.Destroy(ctx, run.ID)
		}

		recovered = append(recovered, run.ID)
	}

	return recovered, nil
}
