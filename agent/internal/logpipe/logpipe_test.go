package logpipe

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/redact"
)

func TestLogPath(t *testing.T) {
	got := LogPath("/var/lib/zeroci", "01j7run", "lint")
	want := filepath.Join("/var/lib/zeroci", "runs", "01j7run", "logs", "lint.log")
	if got != want {
		t.Errorf("LogPath = %q, want %q", got, want)
	}
}

func TestPipeWritesRedactedToDisk(t *testing.T) {
	tmpDir := t.TempDir()
	logFile := filepath.Join(tmpDir, "runs", "testrun", "logs", "build.log")

	redactor := redact.New("mysecrettoken")
	pipe, err := New(logFile, redactor)
	if err != nil {
		t.Fatalf("New pipe: %v", err)
	}

	_, _ = pipe.Write([]byte("building project with token: mysecrettoken\n"))
	_, _ = pipe.Write([]byte("compilation successful\n"))
	_ = pipe.Close()

	data, err := os.ReadFile(logFile)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines, got %d: %q", len(lines), string(data))
	}
	if lines[0] != "building project with token: ***" {
		t.Errorf("line 0 = %q", lines[0])
	}
	if lines[1] != "compilation successful" {
		t.Errorf("line 1 = %q", lines[1])
	}
}

func TestPipeTailingSubscription(t *testing.T) {
	tmpDir := t.TempDir()
	logFile := filepath.Join(tmpDir, "job.log")

	pipe, err := New(logFile, nil)
	if err != nil {
		t.Fatalf("New pipe: %v", err)
	}

	sub := pipe.Subscribe(10)

	_, _ = pipe.Write([]byte("first line\n"))
	_, _ = pipe.Write([]byte("second line\n"))
	_ = pipe.Close()

	var received []string
	for line := range sub {
		received = append(received, strings.TrimRight(line, "\r\n"))
	}

	if len(received) != 2 {
		t.Fatalf("expected 2 lines from sub, got %d", len(received))
	}
	if received[0] != "first line" || received[1] != "second line" {
		t.Errorf("received = %v", received)
	}
}

func TestPipeAnnotationsAndSteps(t *testing.T) {
	tmpDir := t.TempDir()
	logFile := filepath.Join(tmpDir, "job.log")

	pipe, err := New(logFile, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	_, _ = pipe.Write([]byte("::step::start::setup\n"))
	_, _ = pipe.Write([]byte("running setup...\n"))
	_, _ = pipe.Write([]byte("::step::end::success\n"))
	_, _ = pipe.Write([]byte("::step::start::test\n"))
	_, _ = pipe.Write([]byte("::error file=main.go,line=42::nil pointer dereference\n"))
	_, _ = pipe.Write([]byte("::warning::slow query detected\n"))
	_, _ = pipe.Write([]byte("::step::end::failure\n"))
	_ = pipe.Close()

	steps := pipe.Steps()
	if len(steps) != 2 {
		t.Fatalf("expected 2 steps, got %d", len(steps))
	}
	if steps[0].Name != "setup" || steps[0].Status != "success" {
		t.Errorf("step 0 = %+v", steps[0])
	}
	if steps[1].Name != "test" || steps[1].Status != "failure" {
		t.Errorf("step 1 = %+v", steps[1])
	}

	anns := pipe.Annotations()
	if len(anns) != 2 {
		t.Fatalf("expected 2 annotations, got %d", len(anns))
	}
	if anns[0].Level != "error" || anns[0].File != "main.go" || anns[0].Line != 42 || anns[0].Message != "nil pointer dereference" {
		t.Errorf("ann 0 = %+v", anns[0])
	}
	if anns[1].Level != "warning" || anns[1].Message != "slow query detected" {
		t.Errorf("ann 1 = %+v", anns[1])
	}
}

func TestTailFile(t *testing.T) {
	tmpDir := t.TempDir()
	logFile := filepath.Join(tmpDir, "follow.log")

	_ = os.WriteFile(logFile, []byte("line 1\nline 2\n"), 0644)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	ch, err := TailFile(ctx, logFile)
	if err != nil {
		t.Fatalf("TailFile: %v", err)
	}

	var got []string
	for line := range ch {
		got = append(got, strings.TrimRight(line, "\r\n"))
		if len(got) == 2 {
			cancel()
		}
	}

	if len(got) != 2 || got[0] != "line 1" || got[1] != "line 2" {
		t.Errorf("got = %v", got)
	}
}
