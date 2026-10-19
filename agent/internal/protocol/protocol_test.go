package protocol

import (
	"encoding/json"
	"testing"
)

func TestProtocolStates(t *testing.T) {
	tests := []struct {
		name  string
		state RunState
		want  string
	}{
		{"queued", RunStateQueued, "Queued"},
		{"running", RunStateRunning, "Running"},
		{"success", RunStateSuccess, "Success"},
		{"failed", RunStateFailed, "Failed"},
		{"verifying", RunStateVerifying, "Verifying"},
		{"rolling_back", RunStateRollingBack, "RollingBack"},
		{"interrupted", RunStateInterrupted, "Interrupted"},
		{"superseded", RunStateSuperseded, "Superseded"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b, err := json.Marshal(tt.state)
			if err != nil {
				t.Fatalf("marshal failed: %v", err)
			}
			if string(b) != `"`+tt.want+`"` {
				t.Fatalf("expected %q, got %s", tt.want, string(b))
			}
		})
	}
}

func TestJobStates(t *testing.T) {
	valid := []JobState{
		JobStateQueued,
		JobStateRunning,
		JobStateSuccess,
		JobStateFailed,
		JobStateCancelled,
		JobStateSkipped,
	}

	for _, s := range valid {
		b, err := json.Marshal(s)
		if err != nil {
			t.Fatalf("marshal failed: %v", err)
		}
		var unmarshaled JobState
		if err := json.Unmarshal(b, &unmarshaled); err != nil {
			t.Fatalf("unmarshal failed: %v", err)
		}
		if unmarshaled != s {
			t.Fatalf("expected %s, got %s", s, unmarshaled)
		}
	}
}
