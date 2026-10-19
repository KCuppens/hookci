package sink

import (
	"context"
	"fmt"

	"github.com/KCuppens/zerocideploy/agent/internal/hubclient"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
)

// MaxAnnotationsPerFrame bounds the items of one annotations frame.
const MaxAnnotationsPerFrame = 50

// HubSink writes the daemon's own frames for one run (the _config check, its
// annotations and job plan) to the store outbox through the hub client, which
// flushes them to the hub. Run and job events of the executor reach the same
// outbox through the store and need no sink.
type HubSink struct {
	runID string
	c     *hubclient.Client
}

// NewHub returns a HubSink for runID.
func NewHub(c *hubclient.Client, runID string) *HubSink {
	return &HubSink{runID: runID, c: c}
}

// Emit queues ev for the run.
func (h *HubSink) Emit(ctx context.Context, ev protocol.Event) error {
	ev.RunId = h.runID
	if _, err := h.c.Send(ctx, ev); err != nil {
		return fmt.Errorf("sink: hub event: %w", err)
	}
	return nil
}

// Annotations queues items for job in frames of at most
// MaxAnnotationsPerFrame items, each carrying the full count as total.
func (h *HubSink) Annotations(ctx context.Context, job string, items []protocol.AnnotationsItemsElem) error {
	total := len(items)
	for start := 0; start < len(items); start += MaxAnnotationsPerFrame {
		end := min(start+MaxAnnotationsPerFrame, len(items))
		f := protocol.Annotations{RunId: h.runID, Job: job, Items: items[start:end], Total: &total}
		if _, err := h.c.Send(ctx, f); err != nil {
			return fmt.Errorf("sink: hub annotations: %w", err)
		}
	}
	return nil
}

// JobPlanned queues the run's job plan.
func (h *HubSink) JobPlanned(ctx context.Context, jobs []protocol.JobPlannedJobsElem) error {
	if _, err := h.c.Send(ctx, protocol.JobPlanned{RunId: h.runID, Jobs: jobs}); err != nil {
		return fmt.Errorf("sink: hub job_planned: %w", err)
	}
	return nil
}
