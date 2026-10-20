package sink

import (
	"context"
	"errors"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/logpipe"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func appendFrame(t *testing.T, st *store.Store, kind string, msg any) int64 {
	t.Helper()
	payload, err := protocol.Marshal(kind, msg)
	if err != nil {
		t.Fatal(err)
	}
	seq, err := st.AppendOutbox(context.Background(), kind, payload)
	if err != nil {
		t.Fatal(err)
	}
	return seq
}

func pendingSeqs(t *testing.T, st *store.Store) []int64 {
	t.Helper()
	items, err := st.Pending(context.Background(), 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	var seqs []int64
	for _, it := range items {
		seqs = append(seqs, it.Seq)
	}
	return seqs
}

func TestPumpDeliversInOrderAndAcks(t *testing.T) {
	ctx := context.Background()
	st := openStore(t)
	run := store.Run{ID: "r1", Repo: "acme/web", SHA: "abc123", Ref: "main", Event: "push", Kind: "check", TrustDomain: "trusted:acme/web"}
	// Rows: 1 run queued event, 2 job_planned (not delivered), 3 annotations, 4 run running event.
	if err := st.CreateRun(ctx, run, []store.Job{{Name: "lint"}}); err != nil {
		t.Fatal(err)
	}
	col, total := 3, 4
	annSeq := appendFrame(t, st, string(KindAnnotations), protocol.Annotations{
		RunId: "r1", Job: "lint", Total: &total,
		Items: []protocol.AnnotationsItemsElem{{Path: "src/a.ts", Line: 7, Column: &col, Level: "failure", Message: "bad"}},
	})
	if err := st.Transition(ctx, "r1", []store.RunState{store.RunQueued}, store.RunRunning, ""); err != nil {
		t.Fatal(err)
	}

	rec := &Recorder{}
	p := &Pump{Store: st, Sink: rec}
	n, err := p.Drain(ctx)
	if err != nil {
		t.Fatalf("Drain: %v", err)
	}
	got := rec.Events()
	if n != 3 || len(got) != 3 {
		t.Fatalf("delivered %d, recorded %+v; want 3 events", n, got)
	}
	if seqs := []int64{got[0].Seq, got[1].Seq, got[2].Seq}; !slices.IsSorted(seqs) || seqs[1] != annSeq {
		t.Errorf("delivered seqs %v, want ascending with annotations at %d", seqs, annSeq)
	}
	wantKinds := []Kind{KindRun, KindAnnotations, KindRun}
	wantStates := []string{"queued", "", "running"}
	for i, e := range got {
		if e.Kind != wantKinds[i] || e.State != wantStates[i] || e.RunID != "r1" || e.Repo != "acme/web" || e.SHA != "abc123" || e.At.IsZero() {
			t.Errorf("event %d = %+v, want kind %s state %q for r1 acme/web@abc123", i, e, wantKinds[i], wantStates[i])
		}
	}
	wantAnn := logpipe.Annotation{Path: "src/a.ts", Line: 7, Column: 3, Level: logpipe.LevelFailure, Message: "bad"}
	if anns := got[1].Annotations; len(anns) != 1 || anns[0] != wantAnn || got[1].Job != "lint" || got[1].AnnotationsTotal != 4 {
		t.Errorf("annotations event = %+v, want job lint with %+v of 4", got[1], wantAnn)
	}
	if seqs := pendingSeqs(t, st); len(seqs) != 0 {
		t.Errorf("Pending after Drain = %v, want empty", seqs)
	}
}

func TestPumpStopsOnError(t *testing.T) {
	ctx := context.Background()
	st := openStore(t)
	var seqs []int64
	for _, state := range []protocol.EventState{"queued", "running", "success"} {
		seqs = append(seqs, appendFrame(t, st, store.KindEvent, protocol.Event{RunId: "r1", State: state}))
	}

	boom := errors.New("boom")
	failing := &failSink{err: boom, failOn: 2}
	n, err := (&Pump{Store: st, Sink: failing}).Drain(ctx)
	if !errors.Is(err, boom) || n != 1 {
		t.Fatalf("Drain = %d, %v; want 1 delivered and an error wrapping boom", n, err)
	}
	if got := pendingSeqs(t, st); !slices.Equal(got, seqs[1:]) {
		t.Fatalf("Pending = %v, want rows 2 and 3 %v", got, seqs[1:])
	}

	// The retry delivers rows 2 and 3 only: row 1 was acked on its own.
	rec := &Recorder{}
	if _, err := (&Pump{Store: st, Sink: rec}).Drain(ctx); err != nil {
		t.Fatalf("retry Drain: %v", err)
	}
	var got []int64
	for _, e := range rec.Events() {
		got = append(got, e.Seq)
	}
	if !slices.Equal(got, seqs[1:]) {
		t.Errorf("retry delivered %v, want %v", got, seqs[1:])
	}
}

func TestPumpRunWarnsAndKeepsPollingAfterDrainError(t *testing.T) {
	st := openStore(t)
	seq := appendFrame(t, st, store.KindEvent, protocol.Event{RunId: "r1", State: "running"})
	boom := errors.New("boom")
	failing := &failSink{err: boom, failOn: 1}
	warned := make(chan error, 10)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	p := &Pump{Store: st, Sink: failing, Poll: time.Millisecond, Warn: func(err error) { warned <- err }}
	go func() { done <- p.Run(ctx) }()

	if err := <-warned; !errors.Is(err, boom) {
		t.Fatalf("warned %v, want an error wrapping boom", err)
	}
	for deadline := time.Now().Add(5 * time.Second); len(pendingSeqs(t, st)) > 0; time.Sleep(time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("row never delivered after the failed Emit")
		}
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run = %v, want nil", err)
	}
	if got := failing.Events(); len(got) != 1 || got[0].Seq != seq {
		t.Errorf("delivered %+v, want seq %d", got, seq)
	}
}

func TestPumpSkipsUndecodableRow(t *testing.T) {
	ctx := context.Background()
	st := openStore(t)
	if _, err := st.AppendOutbox(ctx, store.KindEvent, []byte("not a frame")); err != nil {
		t.Fatal(err)
	}
	good := appendFrame(t, st, store.KindEvent, protocol.Event{RunId: "r1", State: "running"})

	rec := &Recorder{}
	var warned []error
	n, err := (&Pump{Store: st, Sink: rec, Warn: func(err error) { warned = append(warned, err) }}).Drain(ctx)
	if err != nil || n != 1 {
		t.Fatalf("Drain = %d, %v; want 1 delivered and no error", n, err)
	}
	if len(warned) != 1 || !errors.Is(warned[0], errUndecodable) {
		t.Errorf("warned %v, want one undecodable-row warning", warned)
	}
	if got := rec.Events(); len(got) != 1 || got[0].Seq != good {
		t.Errorf("delivered %+v, want seq %d", got, good)
	}
	if got := pendingSeqs(t, st); len(got) != 0 {
		t.Errorf("Pending = %v, want none", got)
	}
}

func TestPumpRunFinalDrainOnCancel(t *testing.T) {
	st := openStore(t)
	seq := appendFrame(t, st, store.KindEvent, protocol.Event{RunId: "r1", State: "running"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec := &Recorder{}
	if err := (&Pump{Store: st, Sink: rec}).Run(ctx); err != nil {
		t.Fatalf("Run after cancel = %v, want nil", err)
	}
	if got := rec.Events(); len(got) != 1 || got[0].Seq != seq {
		t.Errorf("delivered %+v, want seq %d", got, seq)
	}
}
