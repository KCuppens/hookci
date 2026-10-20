package logpipe

import (
	"strconv"
	"testing"
)

func TestRingKeepsLast40(t *testing.T) {
	r := NewRing(TailLines)
	for i := 1; i <= 100; i++ {
		r.Push(strconv.Itoa(i))
	}
	got := r.Lines()
	if len(got) != 40 {
		t.Fatalf("len = %d, want 40", len(got))
	}
	for i, line := range got {
		if want := strconv.Itoa(61 + i); line != want {
			t.Fatalf("Lines()[%d] = %q, want %q (lines 61 to 100 in order)", i, line, want)
		}
	}
	got[0] = "changed"
	if r.Lines()[0] != "61" {
		t.Error("Lines does not return a copy")
	}
}
