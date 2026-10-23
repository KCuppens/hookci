package daemon

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"slices"
	"time"

	"github.com/KCuppens/hookci/agent/internal/logpipe"
	"github.com/KCuppens/hookci/agent/internal/logupload"
	"github.com/KCuppens/hookci/agent/internal/scheduler"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// uploadTimeout bounds one job's log upload, retries included.
const uploadTimeout = 30 * time.Second

// logRunner uploads each job's log to the hub when the job ends, before the
// scheduler records the job's terminal event, so the hub has the log by the
// time it alerts on the run. With local set (`logs: local`) nothing is
// uploaded and the outcome says the log stays on the agent.
type logRunner struct {
	scheduler.JobRunner
	st     *store.Store
	up     *logupload.Uploader
	runDir string
	local  bool
	log    *slog.Logger
}

func (r *logRunner) RunJob(ctx context.Context, run store.Run, job store.Job) (scheduler.JobOutcome, error) {
	out, err := r.JobRunner.RunJob(ctx, run, job)
	if r.local {
		out.LogsLocal = true
		return out, err
	}
	r.upload(context.WithoutCancel(ctx), run.ID, job.Name)
	return out, err
}

// RunSetup treats the setup log like a job's: uploaded when setup ends, or
// left on the agent with `logs: local`. Teardown lines FinishRun appends
// later stay on the agent. A run planned without a setup job (a retry of a
// run an older agent planned) has no setup row on the hub, so its setup log
// is neither uploaded nor reported local.
func (r *logRunner) RunSetup(ctx context.Context, run store.Run) (scheduler.JobOutcome, error) {
	out, err := r.JobRunner.RunSetup(ctx, run)
	if !r.setupPlanned(ctx, run.ID) {
		return out, err
	}
	if r.local {
		out.LogsLocal = true
		return out, err
	}
	r.upload(context.WithoutCancel(ctx), run.ID, store.SetupJob)
	return out, err
}

// setupPlanned reports whether the run has a setup job. A store that cannot
// say counts as no, as in the executor.
func (r *logRunner) setupPlanned(ctx context.Context, runID string) bool {
	jobs, err := r.st.Jobs(context.WithoutCancel(ctx), runID)
	if err != nil {
		r.log.Warn("list jobs failed", "run", runID, "err", err)
		return false
	}
	return slices.ContainsFunc(jobs, func(j store.Job) bool { return j.Name == store.SetupJob })
}

// upload sends the job's log file. A failed upload is logged and never
// fails the job; a job that wrote no log has nothing to send.
func (r *logRunner) upload(ctx context.Context, runID, job string) {
	f, err := os.Open(logpipe.LogPath(r.runDir, job))
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	if err != nil {
		r.log.Error("open job log failed", "run", runID, "job", job, "err", err)
		return
	}
	defer f.Close()
	ctx, cancel := context.WithTimeout(ctx, uploadTimeout)
	defer cancel()
	res, err := r.up.Upload(ctx, runID, job, f)
	if err != nil {
		r.log.Error("upload job log failed", "run", runID, "job", job, "err", err)
		return
	}
	r.log.Debug("uploaded job log", "run", runID, "job", job, "bytes", res.Bytes, "truncated", res.Truncated)
}
