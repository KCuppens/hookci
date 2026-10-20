package executor

import (
	"context"

	"github.com/KCuppens/zerocideploy/agent/internal/logpipe"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

// appendStep writes a step event for a running job. It is not a job state
// change, so it goes to the outbox directly instead of through TransitionJob.
// logpipe counts steps from 1, the protocol from 0. total is the marker count
// of the job's script (logpipe.CountStepMarkers); the step total sent is the
// larger of it and the step's number, and is left out when total is 0.
func (e *Executor) appendStep(ctx context.Context, runID, job string, s logpipe.StepEvent, total int) error {
	idx := s.Index - 1
	var stepsTotal *int
	if total > 0 {
		n := max(total, s.Index)
		stepsTotal = &n
	}
	_, err := e.o.Store.AppendSeqFrame(ctx, store.KindEvent, func(seq int) any {
		return protocol.Event{
			AgentSeq:   seq,
			RunId:      runID,
			Job:        &job,
			State:      protocol.EventState(store.JobRunning),
			Step:       &s.Name,
			StepIndex:  &idx,
			StepsTotal: stepsTotal,
		}
	})
	return err
}

// appendAnnotations writes one annotations frame for a job, with the total
// found counting the dropped ones. Nothing is written when items is empty.
func (e *Executor) appendAnnotations(ctx context.Context, runID, job string, items []logpipe.Annotation, dropped int) error {
	if len(items) == 0 {
		return nil
	}
	out := make([]protocol.AnnotationsItemsElem, len(items))
	for i, a := range items {
		out[i] = protocol.AnnotationsItemsElem{
			Path:    a.Path,
			Line:    a.Line,
			Level:   protocol.AnnotationsItemsElemLevel(a.Level),
			Message: a.Message,
		}
		if a.Column > 0 {
			col := a.Column
			out[i].Column = &col
		}
		if a.Title != "" {
			title := a.Title
			out[i].Title = &title
		}
	}
	total := len(items) + dropped
	_, err := e.o.Store.AppendSeqFrame(ctx, store.KindAnnotations, func(seq int) any {
		return protocol.Annotations{AgentSeq: seq, RunId: runID, Job: job, Items: out, Total: &total}
	})
	return err
}
