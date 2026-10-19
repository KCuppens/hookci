package sink

import (
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"

	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

const (
	minJobWidth       = 8
	maxAnnotationRows = 10

	colorGreen  = "\x1b[32m"
	colorRed    = "\x1b[31m"
	colorYellow = "\x1b[33m"
	colorReset  = "\x1b[0m"
)

// isTerminal is swapped by tests.
var isTerminal = term.IsTerminal

// ColorEnabled is true when f is a terminal (golang.org/x/term IsTerminal)
// and NO_COLOR is unset or empty.
func ColorEnabled(f *os.File, getenv func(string) string) bool {
	if f == nil || getenv("NO_COLOR") != "" {
		return false
	}
	return isTerminal(int(f.Fd()))
}

// StdoutOptions configures a Stdout sink.
type StdoutOptions struct {
	Out     io.Writer        // nil means os.Stdout
	Color   bool             // use ColorEnabled(f) to decide
	Clock   func() time.Time // stamps events with a zero At; nil means time.Now
	Verbose bool             // print step events
}

// Stdout prints events as human-readable lines for `zeroci run`.
type Stdout struct {
	mu      sync.Mutex
	out     io.Writer
	color   bool
	clock   func() time.Time
	verbose bool
	width   int // job name column: longest job seen so far, at least minJobWidth
	runs    map[string]*runTrack
}

// runTrack is what the run summary and annotation cap need to remember.
type runTrack struct {
	start     time.Time
	jobs      map[string]bool
	annotated map[string]int // annotation lines printed per job
}

// NewStdout returns a Stdout sink.
func NewStdout(o StdoutOptions) *Stdout {
	if o.Out == nil {
		o.Out = os.Stdout
	}
	if o.Clock == nil {
		o.Clock = time.Now
	}
	return &Stdout{
		out:     o.Out,
		color:   o.Color,
		clock:   o.Clock,
		verbose: o.Verbose,
		width:   minJobWidth,
		runs:    map[string]*runTrack{},
	}
}

// Name returns "stdout".
func (s *Stdout) Name() string { return "stdout" }

// Close does nothing; the writer belongs to the caller.
func (s *Stdout) Close() error { return nil }

// Emit prints e. Step events are printed only in verbose mode.
func (s *Stdout) Emit(_ context.Context, e Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	at := e.At
	if at.IsZero() {
		at = s.clock()
	}
	if len(e.Job) > s.width {
		s.width = len(e.Job)
	}
	r := s.track(e.RunID, at)
	if e.Job != "" {
		r.jobs[e.Job] = true
	}

	var b strings.Builder
	switch e.Kind {
	case KindRun:
		s.runLine(&b, e, at, r)
	case KindJob:
		s.jobLine(&b, e, at)
	case KindStep:
		if !s.verbose {
			return nil
		}
		s.stamp(&b, at)
		fmt.Fprintf(&b, "%-*s step ", s.width, e.Job)
		if e.StepsTotal > 0 {
			fmt.Fprintf(&b, "%d/%d ", e.StepIndex+1, e.StepsTotal)
		}
		b.WriteString(e.Step + "\n")
	case KindAnnotations:
		annotationLines(&b, e, r)
	default:
		return fmt.Errorf("stdout: unknown event kind %q", e.Kind)
	}
	_, err := io.WriteString(s.out, b.String())
	return err
}

// track returns the bookkeeping for runID, creating it with start at.
func (s *Stdout) track(runID string, at time.Time) *runTrack {
	r, ok := s.runs[runID]
	if !ok {
		r = &runTrack{start: at, jobs: map[string]bool{}, annotated: map[string]int{}}
		s.runs[runID] = r
	}
	return r
}

func (s *Stdout) runLine(b *strings.Builder, e Event, at time.Time, r *runTrack) {
	s.stamp(b, at)
	b.WriteString("run " + e.RunID + " " + s.paint(e.State))
	state := store.RunState(e.State)
	if state == store.RunRunning {
		r.start = at
	}
	if !state.Terminal() {
		b.WriteString("\n")
		return
	}
	ms := e.DurationMS
	if ms <= 0 {
		ms = at.Sub(r.start).Milliseconds()
	}
	noun := "jobs"
	if len(r.jobs) == 1 {
		noun = "job"
	}
	fmt.Fprintf(b, " (%d %s, %s)\n", len(r.jobs), noun, formatDuration(ms))
	delete(s.runs, e.RunID)
}

func (s *Stdout) jobLine(b *strings.Builder, e Event, at time.Time) {
	s.stamp(b, at)
	fmt.Fprintf(b, "%-*s %s", s.width, e.Job, s.paint(e.State))
	if store.JobState(e.State).Terminal() && e.DurationMS > 0 {
		b.WriteString(" " + formatDuration(e.DurationMS))
	}
	b.WriteString("\n")
	if e.State != string(store.JobFailed) {
		return
	}
	for _, line := range e.Tail {
		b.WriteString("  | " + line + "\n")
	}
	if e.Reason != "" {
		b.WriteString("  reason: " + e.Reason + "\n")
	}
}

// annotationLines prints up to maxAnnotationRows annotations per job, then
// how many of the job's annotations were left out, counting those the
// executor dropped before the frame.
func annotationLines(b *strings.Builder, e Event, r *runTrack) {
	printed := r.annotated[e.Job]
	shown := 0
	for _, a := range e.Annotations {
		if printed == maxAnnotationRows {
			break
		}
		loc := a.Path + ":" + strconv.Itoa(a.Line)
		if a.Column > 0 {
			loc += ":" + strconv.Itoa(a.Column)
		}
		fmt.Fprintf(b, "  %s %s %s\n", loc, a.Level, a.Message)
		printed++
		shown++
	}
	if more := max(e.AnnotationsTotal, len(e.Annotations)) - shown; more > 0 {
		fmt.Fprintf(b, "  ... and %d more\n", more)
	}
	r.annotated[e.Job] = printed
}

func (s *Stdout) stamp(b *strings.Builder, at time.Time) {
	b.WriteString(at.Format("[15:04:05] "))
}

// paint wraps state in its color when color is on and the state has one.
func (s *Stdout) paint(state string) string {
	if !s.color {
		return state
	}
	var c string
	switch state {
	case string(store.RunSuccess):
		c = colorGreen
	case string(store.RunFailed):
		c = colorRed
	case string(store.RunCancelled), string(store.RunSuperseded), string(store.RunInterrupted):
		c = colorYellow
	default:
		return state
	}
	return c + state + colorReset
}

// formatDuration renders ms as 850ms, 2.1s or 1m04s.
func formatDuration(ms int64) string {
	if ms < 1000 {
		return strconv.FormatInt(ms, 10) + "ms"
	}
	if tenths := (ms + 50) / 100; tenths < 600 {
		return fmt.Sprintf("%d.%ds", tenths/10, tenths%10)
	}
	sec := (ms + 500) / 1000
	return fmt.Sprintf("%dm%02ds", sec/60, sec%60)
}
