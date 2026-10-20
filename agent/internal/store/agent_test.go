package store

import (
	"context"
	"testing"
)

// seedSession gives s an unacknowledged frame, both high-water marks, a hub
// trigger and a run.
func seedSession(t *testing.T, s *Store) {
	t.Helper()
	ctx := context.Background()
	if err := s.CreateRun(ctx, testRun("r1"), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AcceptTrigger(ctx, "trg_1", "r1"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetHWM(ctx, HWMIn, 7); err != nil {
		t.Fatal(err)
	}
	if err := s.Ack(ctx, 1); err != nil {
		t.Fatal(err)
	}
}

func TestBindAgentKeepsOwnSession(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	if reset, err := s.BindAgent(ctx, "agt_1"); err != nil || reset {
		t.Fatalf("first BindAgent = %v, %v; want no reset", reset, err)
	}
	seedSession(t, s)
	before, err := s.Pending(ctx, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if reset, err := s.BindAgent(ctx, "agt_1"); err != nil || reset {
		t.Fatalf("BindAgent same agent = %v, %v; want no reset", reset, err)
	}
	after, err := s.Pending(ctx, 0, 0)
	if err != nil || len(after) != len(before) || len(after) == 0 {
		t.Fatalf("pending after rebind = %d items, %v; want %d", len(after), err, len(before))
	}
	if hwm, err := s.GetHWM(ctx, HWMIn); err != nil || hwm != 7 {
		t.Fatalf("in hwm = %d, %v; want 7", hwm, err)
	}
	if trs, err := s.ListTriggers(ctx); err != nil || len(trs) != 1 {
		t.Fatalf("triggers = %v, %v; want trg_1", trs, err)
	}
}

func TestBindAgentDropsReplacedAgentSession(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	if _, err := s.BindAgent(ctx, "agt_old"); err != nil {
		t.Fatal(err)
	}
	seedSession(t, s)

	if reset, err := s.BindAgent(ctx, "agt_new"); err != nil || !reset {
		t.Fatalf("BindAgent new agent = %v, %v; want reset", reset, err)
	}
	if items, err := s.Pending(ctx, 0, 0); err != nil || len(items) != 0 {
		t.Fatalf("pending = %d items, %v; want none", len(items), err)
	}
	for _, dir := range []string{HWMIn, HWMOutAcked} {
		if hwm, err := s.GetHWM(ctx, dir); err != nil || hwm != 0 {
			t.Errorf("%s hwm = %d, %v; want 0", dir, hwm, err)
		}
	}
	if trs, err := s.ListTriggers(ctx); err != nil || len(trs) != 0 {
		t.Errorf("triggers = %v, %v; want none", trs, err)
	}
	if seq, err := s.AppendOutbox(ctx, "event", []byte(`{}`)); err != nil || seq != 1 {
		t.Errorf("next seq = %d, %v; want 1", seq, err)
	}
	if runs, err := s.ListRuns(ctx, RunFilter{}); err != nil || len(runs) != 1 {
		t.Errorf("runs = %d, %v; want r1 kept", len(runs), err)
	}
	if reset, err := s.BindAgent(ctx, "agt_new"); err != nil || reset {
		t.Errorf("BindAgent again = %v, %v; want no reset", reset, err)
	}
}
