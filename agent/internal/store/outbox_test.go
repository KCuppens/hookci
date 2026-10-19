package store

import (
	"context"
	"fmt"
	"testing"
)

func seqs(items []OutboxItem) []int64 {
	out := make([]int64, 0, len(items))
	for _, it := range items {
		out = append(out, it.Seq)
	}
	return out
}

func TestOutboxAckAndPending(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	for i := 1; i <= 5; i++ {
		seq, err := s.AppendOutbox(ctx, "test", []byte(fmt.Sprintf("p%d", i)))
		if err != nil {
			t.Fatalf("AppendOutbox: %v", err)
		}
		if seq != int64(i) {
			t.Fatalf("AppendOutbox seq = %d, want %d", seq, i)
		}
	}

	items, err := s.Pending(ctx, 0, 10)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if got := fmt.Sprint(seqs(items)); got != "[1 2 3 4 5]" {
		t.Fatalf("Pending(0, 10) = %s, want [1 2 3 4 5]", got)
	}
	if string(items[0].Payload) != "p1" || items[0].Kind != "test" || items[0].CreatedAt.IsZero() {
		t.Errorf("item 1 = %+v", items[0])
	}
	if limited, err := s.Pending(ctx, 0, 2); err != nil || fmt.Sprint(seqs(limited)) != "[1 2]" {
		t.Errorf("Pending(0, 2) = %v, %v; want [1 2]", seqs(limited), err)
	}

	if err := s.Ack(ctx, 3); err != nil {
		t.Fatalf("Ack(3): %v", err)
	}
	if n := outboxCount(t, s); n != 2 {
		t.Errorf("outbox rows after Ack(3) = %d, want 2", n)
	}
	if hwm, err := s.GetHWM(ctx, HWMOutAcked); err != nil || hwm != 3 {
		t.Errorf("out_acked = %d, %v; want 3", hwm, err)
	}
	items, err = s.Pending(ctx, 3, 10)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if got := fmt.Sprint(seqs(items)); got != "[4 5]" {
		t.Errorf("Pending(3, 10) = %s, want [4 5]", got)
	}

	if err := s.Ack(ctx, 2); err != nil {
		t.Fatalf("Ack(2): %v", err)
	}
	if hwm, err := s.GetHWM(ctx, HWMOutAcked); err != nil || hwm != 3 {
		t.Errorf("out_acked after Ack(2) = %d, %v; want 3", hwm, err)
	}

	seq, err := s.AppendOutbox(ctx, "test", []byte("p6"))
	if err != nil || seq != 6 {
		t.Errorf("AppendOutbox after ack = %d, %v; want seq 6 (never reused)", seq, err)
	}
}

func TestSetHWMMonotonic(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	if hwm, err := s.GetHWM(ctx, HWMIn); err != nil || hwm != 0 {
		t.Fatalf("initial in = %d, %v; want 0", hwm, err)
	}
	for _, step := range []struct{ set, want int64 }{{5, 5}, {3, 5}, {5, 5}, {9, 9}, {0, 9}} {
		if err := s.SetHWM(ctx, HWMIn, step.set); err != nil {
			t.Fatalf("SetHWM(%d): %v", step.set, err)
		}
		if hwm, err := s.GetHWM(ctx, HWMIn); err != nil || hwm != step.want {
			t.Errorf("after SetHWM(%d) in = %d, %v; want %d", step.set, hwm, err, step.want)
		}
	}
	if hwm, err := s.GetHWM(ctx, HWMOutAcked); err != nil || hwm != 0 {
		t.Errorf("out_acked = %d, %v; want 0 (independent of in)", hwm, err)
	}
	if err := s.SetHWM(ctx, "sideways", 1); err == nil {
		t.Error("SetHWM with unknown direction succeeded")
	}
}
