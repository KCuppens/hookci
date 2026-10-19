package ids

import (
	"bytes"
	"regexp"
	"testing"
	"time"
)

var runIDPattern = regexp.MustCompile(`^[0-7][0-9a-hjkmnp-tv-z]{25}$`)

func TestNewRunIDFormat(t *testing.T) {
	id := NewRunID()
	if !runIDPattern.MatchString(id) {
		t.Fatalf("NewRunID() = %q, want match of %s", id, runIDPattern.String())
	}
}

func TestNewRunIDAtSortable(t *testing.T) {
	zero := bytes.NewReader(make([]byte, 10))
	t1 := time.UnixMilli(1_700_000_000_000)
	t2 := time.UnixMilli(1_700_000_000_001)

	id1 := NewRunIDAt(t1, bytes.NewReader(make([]byte, 10)))
	id2 := NewRunIDAt(t2, bytes.NewReader(make([]byte, 10)))
	if id1 >= id2 {
		t.Fatalf("NewRunIDAt(t1) = %q, NewRunIDAt(t2) = %q, want t1 < t2 lexically", id1, id2)
	}

	again := NewRunIDAt(t1, zero)
	if id1 != again {
		t.Fatalf("NewRunIDAt(t1, zero reader) = %q, want deterministic %q", again, id1)
	}
}

func TestValidRunID(t *testing.T) {
	valid := NewRunIDAt(time.UnixMilli(1_700_000_000_000), bytes.NewReader(make([]byte, 10)))

	cases := []struct {
		name string
		id   string
		want bool
	}{
		{"valid", valid, true},
		{"empty", "", false},
		{"too short", valid[:25], false},
		{"too long", valid + "0", false},
		{"uppercase", "A" + valid[1:], false},
		{"excludes i", "i" + valid[1:], false},
		{"excludes l", "l" + valid[1:], false},
		{"excludes o", "o" + valid[1:], false},
		{"excludes u", "u" + valid[1:], false},
		{"first char out of range", "8" + valid[1:], false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ValidRunID(tc.id); got != tc.want {
				t.Errorf("ValidRunID(%q) = %v, want %v", tc.id, got, tc.want)
			}
		})
	}
}
