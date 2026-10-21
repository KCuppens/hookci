package sink

import (
	"context"
	"errors"
	"sync"
	"testing"
)

// failSink records events and fails the failOn-th Emit (1-based) with err;
// failOn 0 fails every Emit.
type failSink struct {
	Recorder
	err    error
	failOn int
	calls  int
}

func (f *failSink) Name() string { return "fail" }

func (f *failSink) Emit(ctx context.Context, e Event) error {
	f.calls++
	if f.failOn == 0 || f.calls == f.failOn {
		return f.err
	}
	return f.Recorder.Emit(ctx, e)
}

func TestMultiJoinsErrors(t *testing.T) {
	errA, errB := errors.New("a down"), errors.New("b down")
	a := &failSink{err: errA}
	rec := &Recorder{}
	b := &failSink{err: errB}
	m := Multi{a, rec, b}

	err := m.Emit(context.Background(), Event{Kind: KindRun, RunID: "r1", State: "running"})
	if !errors.Is(err, errA) || !errors.Is(err, errB) {
		t.Fatalf("Emit error = %v, want it to wrap both failures", err)
	}
	if got := rec.Events(); len(got) != 1 || got[0].RunID != "r1" {
		t.Errorf("sink after the failing one got %+v, want the event", got)
	}
	if b.calls != 1 {
		t.Errorf("last sink called %d times, want 1", b.calls)
	}
}

func TestRecorderConcurrent(t *testing.T) {
	rec := &Recorder{}
	var wg sync.WaitGroup
	for i := range 100 {
		wg.Go(func() {
			_ = rec.Emit(context.Background(), Event{Seq: int64(i)})
		})
	}
	wg.Wait()
	if n := len(rec.Events()); n != 100 {
		t.Fatalf("Events has %d entries, want 100", n)
	}
}
