package sink

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/KCuppens/hookci/agent/internal/logpipe"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/store"
)

const (
	pumpBatch   = 100
	defaultPoll = 100 * time.Millisecond
)

// errUndecodable marks an outbox row whose payload cannot be decoded. Retrying
// it cannot succeed, so Drain skips it instead of blocking the rows after it.
var errUndecodable = errors.New("undecodable outbox row")

// Pump drains store outbox rows in agent_seq order to s and acks each delivered row.
type Pump struct {
	Store *store.Store
	Sink  Sink
	Poll  time.Duration // interval for Run; zero means 100ms
	Warn  func(error)   // reports skipped rows and Drain errors Run retries; nil discards

	run store.Run // last run looked up, for Repo and SHA
}

// Drain delivers every pending outbox row, acking each one after its Emit
// succeeds. Rows of other kinds (job_planned) are acked without delivery, and
// rows that fail to decode are reported to Warn and acked without delivery. On
// an Emit error it stops and returns without acking that row, so delivery is
// at-least-once.
func (p *Pump) Drain(ctx context.Context) (delivered int, err error) {
	for {
		items, err := p.Store.Pending(ctx, 0, pumpBatch)
		if err != nil {
			return delivered, err
		}
		for _, it := range items {
			e, ok, err := p.decode(ctx, it)
			switch {
			case errors.Is(err, errUndecodable):
				p.warn(err)
			case err != nil:
				return delivered, err
			case ok:
				if err := p.Sink.Emit(ctx, e); err != nil {
					return delivered, fmt.Errorf("sink %s: emit seq %d: %w", p.Sink.Name(), it.Seq, err)
				}
				delivered++
			}
			if err := p.Store.Ack(ctx, it.Seq); err != nil {
				return delivered, err
			}
		}
		if len(items) < pumpBatch {
			return delivered, nil
		}
	}
}

// Run calls Drain every Poll until ctx is done, then drains once more so no
// event written before cancellation is lost. A Drain error is reported to Warn
// (once until the error changes or a Drain succeeds) and retried on the next
// poll. It returns the final Drain's error.
func (p *Pump) Run(ctx context.Context) error {
	poll := p.Poll
	if poll <= 0 {
		poll = defaultPoll
	}
	t := time.NewTicker(poll)
	defer t.Stop()
	var last string
	for {
		_, err := p.Drain(ctx)
		switch {
		case err == nil:
			last = ""
		case ctx.Err() == nil && err.Error() != last:
			last = err.Error()
			p.warn(err)
		}
		select {
		case <-ctx.Done():
			_, err := p.Drain(context.WithoutCancel(ctx))
			return err
		case <-t.C:
		}
	}
}

func (p *Pump) warn(err error) {
	if p.Warn != nil {
		p.Warn(err)
	}
}

// decode turns an outbox row into an Event. ok is false for row kinds that
// sinks do not receive. A payload that does not decode returns an error
// wrapping errUndecodable.
func (p *Pump) decode(ctx context.Context, it store.OutboxItem) (e Event, ok bool, err error) {
	e = Event{Seq: it.Seq, At: it.CreatedAt.Local()}
	switch it.Kind {
	case store.KindEvent:
		var ev protocol.Event
		if err := protocol.Unmarshal(it.Payload, &ev); err != nil {
			return e, false, fmt.Errorf("sink: skip outbox seq %d: %w: %w", it.Seq, errUndecodable, err)
		}
		e.RunID = ev.RunId
		e.State = string(ev.State)
		e.Kind = KindRun
		if ev.Job != nil {
			e.Job = *ev.Job
			e.Kind = KindJob
		}
		if ev.Step != nil {
			e.Step = *ev.Step
			if e.Kind == KindJob && ev.State == protocol.EventState(store.JobRunning) {
				e.Kind = KindStep
			}
		}
		e.StepIndex = deref(ev.StepIndex)
		e.StepsTotal = deref(ev.StepsTotal)
		e.DurationMS = int64(deref(ev.DurationMs))
		if ev.Reason != nil {
			e.Reason = *ev.Reason
		}
		e.Tail = ev.Tail
	case string(KindAnnotations):
		var a protocol.Annotations
		if err := protocol.Unmarshal(it.Payload, &a); err != nil {
			return e, false, fmt.Errorf("sink: skip outbox seq %d: %w: %w", it.Seq, errUndecodable, err)
		}
		e.Kind = KindAnnotations
		e.RunID = a.RunId
		e.Job = a.Job
		e.AnnotationsTotal = deref(a.Total)
		e.Annotations = make([]logpipe.Annotation, len(a.Items))
		for i, item := range a.Items {
			ann := logpipe.Annotation{
				Path:    item.Path,
				Line:    item.Line,
				Column:  deref(item.Column),
				Level:   logpipe.Level(item.Level),
				Message: item.Message,
			}
			if item.Title != nil {
				ann.Title = *item.Title
			}
			e.Annotations[i] = ann
		}
	default:
		return e, false, nil
	}
	if p.run.ID != e.RunID {
		r, err := p.Store.GetRun(ctx, e.RunID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return e, false, fmt.Errorf("sink: outbox seq %d: %w", it.Seq, err)
		}
		p.run = r
	}
	e.Repo, e.SHA = p.run.Repo, p.run.SHA
	return e, true, nil
}

func deref(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}
