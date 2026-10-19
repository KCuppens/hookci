package redact

import (
	"bytes"
	"strings"
	"testing"
)

func TestRedactSimple(t *testing.T) {
	r := New("ghp_secrettoken123", "supersecretpassword")
	in := "authorization: Bearer ghp_secrettoken123 and supersecretpassword!"
	got := r.Redact(in)
	want := "authorization: Bearer *** and ***!"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestRedactDescendingLength(t *testing.T) {
	r := New("secret", "supersecret")
	in := "value is supersecret"
	got := r.Redact(in)
	want := "value is ***"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestRedactShortIgnored(t *testing.T) {
	r := New("abc", "short")
	in := "abc short def"
	got := r.Redact(in)
	want := "abc *** def"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestWriterChunksAndFlushes(t *testing.T) {
	var buf bytes.Buffer
	r := New("my_secret_token")
	w := r.Writer(&buf)

	// Write across multiple partial chunks
	_, _ = w.Write([]byte("start "))
	_, _ = w.Write([]byte("token: my_secret_token"))
	_, _ = w.Write([]byte(" end\nsecond line without secret\nthird line with my_secret_token"))
	_ = w.Close()

	lines := strings.Split(buf.String(), "\n")
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d: %q", len(lines), buf.String())
	}
	if lines[0] != "start token: *** end" {
		t.Errorf("line 0 = %q", lines[0])
	}
	if lines[1] != "second line without secret" {
		t.Errorf("line 1 = %q", lines[1])
	}
	if lines[2] != "third line with ***" {
		t.Errorf("line 2 = %q", lines[2])
	}
}
