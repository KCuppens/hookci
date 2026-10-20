package redact

import (
	"testing"
	"time"
)

func TestAddSecretMasksInExistingRedactors(t *testing.T) {
	r, _ := New(nil, nil)
	const tok = "tok-abc123secret"
	if got := r.Line("token " + tok); got != "token "+tok {
		t.Fatalf("before AddSecret = %q, want unmasked", got)
	}
	AddSecret(tok, time.Now().Add(time.Hour))
	AddSecret("ab", time.Now().Add(time.Hour)) // too short: ignored
	if got := r.Line("token " + tok + " ab"); got != "token "+Mask+" ab" {
		t.Fatalf("after AddSecret = %q", got)
	}
	r2, _ := New(nil, nil)
	if got := r2.Line(tok); got != Mask {
		t.Fatalf("new redactor = %q, want %q", got, Mask)
	}
}

func TestAddSecretDropsExpired(t *testing.T) {
	const old = "tok-expired-value"
	AddSecret(old, time.Now().Add(-time.Second))
	AddSecret("tok-fresh-value", time.Now().Add(time.Hour))
	for _, s := range *registry.Load() {
		if s.value == old {
			t.Fatalf("expired secret still registered after a later AddSecret")
		}
	}
}
