package sink

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/logpipe"
	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

const runID = "01HXRUN0000000000000000000"

func at(sec int) time.Time {
	return time.Date(2026, 1, 2, 12, 0, sec, 0, time.UTC)
}

func successEvents() []Event {
	return []Event{
		{Kind: KindRun, RunID: runID, State: "running", At: at(3)},
		{Kind: KindJob, RunID: runID, Job: "lint", State: "running", At: at(3)},
		{Kind: KindJob, RunID: runID, Job: "test", State: "running", At: at(3)},
		{Kind: KindJob, RunID: runID, Job: "typecheck", State: "running", At: at(4)},
		{Kind: KindJob, RunID: runID, Job: "lint", State: "success", DurationMS: 2100, At: at(5)},
		{Kind: KindJob, RunID: runID, Job: "typecheck", State: "success", DurationMS: 850, At: at(5)},
		{Kind: KindJob, RunID: runID, Job: "test", State: "success", DurationMS: 5600, At: at(9)},
		{Kind: KindRun, RunID: runID, State: "success", At: at(9)},
	}
}

func failureEvents() []Event {
	return []Event{
		{Kind: KindRun, RunID: runID, State: "running", At: at(0)},
		{Kind: KindJob, RunID: runID, Job: "lint", State: "running", At: at(0)},
		{Kind: KindJob, RunID: runID, Job: "lint", State: "failed", DurationMS: 2100, At: at(2),
			Tail:   []string{"src/a.ts: 1 problem", "error: unused variable x", "lint failed"},
			Reason: "exit 1"},
		{Kind: KindRun, RunID: runID, State: "failed", At: at(2)},
	}
}

func render(t *testing.T, o StdoutOptions, events []Event) string {
	t.Helper()
	var buf bytes.Buffer
	o.Out = &buf
	s := NewStdout(o)
	for _, e := range events {
		if err := s.Emit(context.Background(), e); err != nil {
			t.Fatalf("Emit(%+v): %v", e, err)
		}
	}
	return buf.String()
}

func TestStdoutSuccessGolden(t *testing.T) {
	testutil.Golden(t, "stdout_success", []byte(render(t, StdoutOptions{}, successEvents())))
}

func TestStdoutFailureGolden(t *testing.T) {
	got := render(t, StdoutOptions{}, failureEvents())
	for _, want := range []string{"  | error: unused variable x\n", "  reason: exit 1\n"} {
		if !strings.Contains(got, want) {
			t.Errorf("output lacks %q:\n%s", want, got)
		}
	}
	testutil.Golden(t, "stdout_failure", []byte(got))
}

func TestStdoutNoColorCodesWhenDisabled(t *testing.T) {
	events := append(successEvents(), failureEvents()...)
	events = append(events, Event{Kind: KindRun, RunID: "r2", State: "cancelled", At: at(10)})
	if got := render(t, StdoutOptions{Color: false}, events); strings.Contains(got, "\x1b[") {
		t.Fatalf("output has color codes:\n%q", got)
	}
}

func TestStdoutColorWhenEnabled(t *testing.T) {
	got := render(t, StdoutOptions{Color: true}, []Event{
		{Kind: KindJob, RunID: runID, Job: "lint", State: "running", At: at(1)},
		{Kind: KindJob, RunID: runID, Job: "lint", State: "success", DurationMS: 900, At: at(2)},
	})
	lines := strings.Split(strings.TrimSuffix(got, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want 2:\n%q", len(lines), got)
	}
	if strings.Contains(lines[0], "\x1b[") {
		t.Errorf("running line has color: %q", lines[0])
	}
	if want := "lint     \x1b[32msuccess\x1b[0m 900ms"; !strings.Contains(lines[1], want) {
		t.Errorf("success line = %q, want it to contain %q", lines[1], want)
	}
}

func TestColorEnabled(t *testing.T) {
	f, err := os.Create(filepath.Join(t.TempDir(), "out"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	noEnv := func(string) string { return "" }
	if ColorEnabled(f, noEnv) {
		t.Error("ColorEnabled(regular file) = true, want false")
	}

	orig := isTerminal
	t.Cleanup(func() { isTerminal = orig })
	isTerminal = func(int) bool { return true }
	if !ColorEnabled(f, noEnv) {
		t.Error("ColorEnabled(tty, NO_COLOR unset) = false, want true")
	}
	noColor := func(k string) string {
		if k == "NO_COLOR" {
			return "1"
		}
		return ""
	}
	if ColorEnabled(f, noColor) {
		t.Error("ColorEnabled(tty, NO_COLOR=1) = true, want false")
	}
}

func TestFormatDuration(t *testing.T) {
	for ms, want := range map[int64]string{850: "850ms", 2100: "2.1s", 64000: "1m04s", 6000: "6.0s", 59990: "1m00s"} {
		if got := formatDuration(ms); got != want {
			t.Errorf("formatDuration(%d) = %q, want %q", ms, got, want)
		}
	}
}

func TestStdoutAnnotationsCap(t *testing.T) {
	anns := make([]logpipe.Annotation, 12)
	for i := range anns {
		anns[i] = logpipe.Annotation{Path: "src/a.ts", Line: i + 1, Column: 3, Level: logpipe.LevelFailure, Message: fmt.Sprintf("problem %d", i+1)}
	}
	got := render(t, StdoutOptions{}, []Event{{Kind: KindAnnotations, RunID: runID, Job: "lint", Annotations: anns}})
	lines := strings.Split(strings.TrimSuffix(got, "\n"), "\n")
	if len(lines) != 11 {
		t.Fatalf("got %d lines, want 11:\n%s", len(lines), got)
	}
	if lines[0] != "  src/a.ts:1:3 failure problem 1" {
		t.Errorf("first line = %q", lines[0])
	}
	if lines[9] != "  src/a.ts:10:3 failure problem 10" {
		t.Errorf("tenth line = %q", lines[9])
	}
	if lines[10] != "  ... and 2 more" {
		t.Errorf("last line = %q, want %q", lines[10], "  ... and 2 more")
	}

	// The executor sent 12 of 60 found: the 48 it dropped count too.
	got = render(t, StdoutOptions{}, []Event{{Kind: KindAnnotations, RunID: runID, Job: "lint", Annotations: anns, AnnotationsTotal: 60}})
	if !strings.HasSuffix(got, "\n  ... and 50 more\n") {
		t.Errorf("output with total 60 = %q, want it to end with ... and 50 more", got)
	}
}

func TestStdoutStepsOnlyVerbose(t *testing.T) {
	step := []Event{{Kind: KindStep, RunID: runID, Job: "build", State: "running", Step: "compile", StepIndex: 1, StepsTotal: 5, At: at(4)}}
	if got := render(t, StdoutOptions{}, step); got != "" {
		t.Errorf("non-verbose output = %q, want nothing", got)
	}
	if got, want := render(t, StdoutOptions{Verbose: true}, step), "[12:00:04] build    step 2/5 compile\n"; got != want {
		t.Errorf("verbose output = %q, want %q", got, want)
	}
}
