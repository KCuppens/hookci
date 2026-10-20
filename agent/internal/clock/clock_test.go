package clock

import (
	"testing"
	"time"
)

var start = time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)

func fired(ch <-chan time.Time) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func TestFakeAfterFiresOnlyWhenDue(t *testing.T) {
	f := NewFake(start)
	ch := f.After(10 * time.Second)
	f.Advance(9 * time.Second)
	if fired(ch) {
		t.Fatal("After(10s) fired after 9s")
	}
	f.Advance(time.Second)
	if !fired(ch) {
		t.Fatal("After(10s) did not fire after 10s")
	}
	if got := f.Now(); !got.Equal(start.Add(10 * time.Second)) {
		t.Fatalf("Now = %v, want %v", got, start.Add(10*time.Second))
	}
}

func TestFakeAfterZeroFiresImmediately(t *testing.T) {
	f := NewFake(start)
	if !fired(f.After(0)) {
		t.Fatal("After(0) did not fire without Advance")
	}
}

func TestFakeTicker(t *testing.T) {
	f := NewFake(start)
	tk := f.NewTicker(20 * time.Second)
	f.Advance(19 * time.Second)
	if fired(tk.C()) {
		t.Fatal("ticker fired before its interval")
	}
	f.Advance(time.Second)
	if !fired(tk.C()) {
		t.Fatal("ticker did not fire at 20s")
	}
	f.Advance(20 * time.Second)
	if !fired(tk.C()) {
		t.Fatal("ticker did not fire again at 40s")
	}
	// Missed ticks are dropped: one Advance over three periods yields one tick.
	f.Advance(60 * time.Second)
	if !fired(tk.C()) || fired(tk.C()) {
		t.Fatal("want exactly one buffered tick after a long Advance")
	}
	tk.Stop()
	f.Advance(time.Hour)
	if fired(tk.C()) {
		t.Fatal("stopped ticker fired")
	}
}
