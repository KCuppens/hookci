package hubclient

import (
	"testing"
	"time"
)

func TestBackoffCeilings(t *testing.T) {
	const top = 0.999999
	tests := []struct {
		name     string
		min, max time.Duration
		rand     float64
		want     []time.Duration // approximate: within 1 ms below
	}{
		{"doubles to max", time.Second, 30 * time.Second, top,
			[]time.Duration{1, 2, 4, 8, 16, 30, 30}},
		{"max above 30 s is capped", time.Second, time.Hour, top,
			[]time.Duration{1, 2, 4, 8, 16, 30, 30, 30}},
		{"zero value defaults", 0, 0, top,
			[]time.Duration{1, 2, 4, 8, 16, 30}},
		{"low jitter is floored at 1 s", 2 * time.Second, 30 * time.Second, 0,
			[]time.Duration{1, 1, 1, 1}},
		{"small max", time.Second, 5 * time.Second, top,
			[]time.Duration{1, 2, 4, 5, 5}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			b := Backoff{Min: tc.min, Max: tc.max, Rand: func() float64 { return tc.rand }}
			for i, w := range tc.want {
				want := w * time.Second
				got := b.Next()
				if got > want || got < want-time.Millisecond {
					t.Fatalf("attempt %d: Next() = %v, want about %v", i, got, want)
				}
			}
		})
	}
}

func TestBackoffBounds(t *testing.T) {
	t.Run("1000 samples within 1 s to 30 s", func(t *testing.T) {
		b := Backoff{Min: time.Second, Max: 30 * time.Second}
		for i := range 1000 {
			d := b.Next()
			if d < time.Second || d > 30*time.Second {
				t.Fatalf("sample %d: %v outside [1s, 30s]", i, d)
			}
			if i%50 == 49 {
				b.Disconnected(ResetAfter)
			}
		}
	})
	t.Run("reset after 60 s connected", func(t *testing.T) {
		b := Backoff{Min: time.Second, Max: 30 * time.Second, Rand: func() float64 { return 0.999999 }}
		for range 10 {
			b.Next()
		}
		b.Disconnected(ResetAfter - time.Second)
		if got := b.Next(); got < 29*time.Second {
			t.Fatalf("after a 59 s session Next() = %v, want the 30 s ceiling kept", got)
		}
		b.Disconnected(ResetAfter)
		if got := b.Next(); got > time.Second {
			t.Fatalf("after a 60 s session Next() = %v, want reset to 1 s", got)
		}
		if got := b.Next(); got < time.Second+time.Second/2 {
			t.Fatalf("second attempt after reset = %v, want about 2 s", got)
		}
	})
}
