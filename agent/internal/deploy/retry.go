package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// ErrNotRetryable reports a retry of a run that is not Failed or Interrupted.
var ErrNotRetryable = errors.New("run is not Failed or Interrupted")

// Enqueuer queues a deploy run; retry marks a retry of a Failed or
// Interrupted run. Scheduler is the agent's.
type Enqueuer interface {
	Enqueue(ctx context.Context, runID string, retry bool)
}

// RequestRetry re-queues runID, which must be Failed or Interrupted, as a
// retry under the same run id with attempt+1, and hands it to sched as a
// retry. It returns runID. See PrepareRetry for the errors.
func RequestRetry(ctx context.Context, st *store.Store, sched Enqueuer, runID string) (string, error) {
	if _, err := PrepareRetry(ctx, st, runID); err != nil {
		return "", err
	}
	sched.Enqueue(ctx, runID, true)
	return runID, nil
}

// PrepareRetry re-queues runID, which must be Failed or Interrupted, as a
// retry under the same run id with attempt+1, without scheduling it, and
// returns the run as it was. A run in any other state yields an error
// wrapping ErrNotRetryable; a missing run one wrapping store.ErrNotFound.
func PrepareRetry(ctx context.Context, st *store.Store, runID string) (store.DeployRun, error) {
	run, err := st.GetDeployRun(ctx, runID)
	if err != nil {
		return store.DeployRun{}, fmt.Errorf("deploy: retry: %w", err)
	}
	if !Retryable(run.State) {
		return store.DeployRun{}, fmt.Errorf("deploy: retry %s: run is %s: %w", runID, run.State, ErrNotRetryable)
	}
	if err := st.MarkRetryRequested(ctx, runID, run.State); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// The run left run.State since it was read.
			return store.DeployRun{}, fmt.Errorf("deploy: retry %s: run is no longer %s: %w", runID, run.State, ErrNotRetryable)
		}
		return store.DeployRun{}, fmt.Errorf("deploy: retry: %w", err)
	}
	return run, nil
}

// Retryable reports whether a run in state may be retried.
func Retryable(state string) bool {
	return state == store.DeployFailed || state == store.DeployInterrupted
}

// RetryOp is the agent control op of `zeroci retry`.
const RetryOp = "deploy.retry"

// RetryRequest is the body of RetryOp.
type RetryRequest struct {
	RunID string `json:"run_id"`
}

// RetryReply is the result of RetryOp: the run queued and its new attempt.
type RetryReply struct {
	RunID   string `json:"run_id"`
	Attempt int    `json:"attempt"`
}

// RetryControl serves RetryOp: it retries the RetryRequest's run with
// RequestRetry and answers a RetryReply. Its errors are the messages
// `zeroci retry` prints.
func RetryControl(st *store.Store, sched Enqueuer) func(context.Context, json.RawMessage) (any, error) {
	return func(ctx context.Context, body json.RawMessage) (any, error) {
		var req RetryRequest
		if err := json.Unmarshal(body, &req); err != nil || req.RunID == "" {
			return nil, errors.New("retry needs a run id")
		}
		_, err := RequestRetry(ctx, st, sched, req.RunID)
		switch {
		case errors.Is(err, store.ErrNotFound):
			return nil, fmt.Errorf("no deploy run %s", req.RunID)
		case errors.Is(err, ErrNotRetryable):
			run, gerr := st.GetDeployRun(ctx, req.RunID)
			if gerr != nil {
				return nil, fmt.Errorf("deploy: retry %s: %w", req.RunID, gerr)
			}
			return nil, fmt.Errorf("run %s is %s; only Failed or Interrupted runs can be retried", req.RunID, run.State)
		case err != nil:
			return nil, err
		}
		run, err := st.GetDeployRun(ctx, req.RunID)
		if err != nil {
			return nil, fmt.Errorf("deploy: retry %s: %w", req.RunID, err)
		}
		return RetryReply{RunID: run.RunID, Attempt: run.Attempt}, nil
	}
}
