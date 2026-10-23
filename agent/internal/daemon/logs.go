package daemon

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
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
// later stay on the agent.
func (r *logRunner) RunSetup(ctx context.Context, run store.Run) (scheduler.JobOutcome, error) {
	out, err := r.JobRunner.RunSetup(ctx, run)
	if r.local {
		out.LogsLocal = true
		return out, err
	}
	r.upload(context.WithoutCancel(ctx), run.ID, store.SetupJob)
	return out, err
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
