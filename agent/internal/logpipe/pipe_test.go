package logpipe

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/redact"
)

// stepClock returns a clock that starts at 2026-05-05T14:32:01.123Z and
// advances 10ms per call.
func stepClock() func() time.Time {
	at := time.Date(2026, 5, 5, 14, 32, 1, 123_000_000, time.UTC)
	return func() time.Time {
		t := at
		at = at.Add(10 * time.Millisecond)
		return t
	}
}

// stamp is the prefix stepClock gives its n-th line (0-based).
func stamp(n int) string {
	return time.Date(2026, 5, 5, 14, 32, 1, 123_000_000, time.UTC).Add(time.Duration(n)*10*time.Millisecond).Format(TimestampLayout) + " "
}

func TestPipeWritesRedactedFile(t *testing.T) {
	const secret = "hunter2-very-secret"
	r, _ := redact.New([]string{secret}, nil)
	runDir := t.TempDir()
	var mirror bytes.Buffer
	p, err := New(Options{RunDir: runDir, Job: "test", Redactor: r, Mirror: &mirror, Now: stepClock()})
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(p.Stdout(), "login with %s\n", secret)
	fmt.Fprintf(p.Stderr(), "error: bad token %s\n", secret)
	fmt.Fprintf(p.Stdout(), "unterminated %s", secret)
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}

	path := LogPath(runDir, "test")
	if path != filepath.Join(runDir, "logs", "test.log") {
		t.Errorf("LogPath = %s", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := stamp(0) + "login with ***\n" + stamp(1) + "error: bad token ***\n" + stamp(2) + "unterminated ***"
	if string(data) != want {
		t.Errorf("file = %q, want %q", data, want)
	}
	if want := "login with ***\nerror: bad token ***\nunterminated ***"; mirror.String() != want {
		t.Errorf("mirror = %q, want the redacted lines without the timestamp prefix", mirror.String())
	}
	tail := p.Tail()
	if want := []string{"login with ***", "error: bad token ***", "unterminated ***"}; !slices.Equal(tail, want) {
		t.Errorf("Tail = %q, want %q", tail, want)
	}
	if bytes.Contains(data, []byte(secret)) || strings.Contains(strings.Join(tail, "\n"), secret) {
		t.Error("secret leaked into the file or tail")
	}

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("file mode = %v, want 0600", fi.Mode().Perm())
	}
	di, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if di.Mode().Perm() != 0o700 {
		t.Errorf("logs dir mode = %v, want 0700", di.Mode().Perm())
	}
}

func TestPipeStepMarkers(t *testing.T) {
	runDir := t.TempDir()
	var steps []StepEvent
	p, err := New(Options{RunDir: runDir, Job: "build", OnStep: func(e StepEvent) { steps = append(steps, e) }})
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprint(p.Stdout(), "::hookci step install\nnpm ci\n  ::hookci step build  \n::hookci step \n")
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	want := []StepEvent{{Name: "install", Index: 1}, {Name: "build", Index: 2}}
	if !slices.Equal(steps, want) {
		t.Errorf("steps = %+v, want %+v", steps, want)
	}
	data, _ := os.ReadFile(LogPath(runDir, "build"))
	if !strings.Contains(string(data), "Z ::hookci step install\n") {
		t.Errorf("marker line missing from log: %q", data)
	}
}

func TestCountStepMarkers(t *testing.T) {
	script := "echo '::hookci step install'\nnpm ci\necho \"::hookci step build\"\nmake\nprintf '::hookci step test\\n'"
	if got := CountStepMarkers(script); got != 3 {
		t.Errorf("CountStepMarkers = %d, want 3", got)
	}
	if got := CountStepMarkers("make test"); got != 0 {
		t.Errorf("CountStepMarkers without markers = %d, want 0", got)
	}
}

func TestPipeConcurrentStreams(t *testing.T) {
	runDir := t.TempDir()
	p, err := New(Options{RunDir: runDir, Job: "test"})
	if err != nil {
		t.Fatal(err)
	}
	const n = 1000
	var wg sync.WaitGroup
	for name, dst := range map[string]io.Writer{"out": p.Stdout(), "err": p.Stderr()} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range n {
				// Two writes per line so the other stream can cut in mid-line.
				fmt.Fprintf(dst, "%s-%04d-", name, i)
				fmt.Fprintf(dst, "%s\n", strings.Repeat(name, 10))
			}
		}()
	}
	wg.Wait()
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(LogPath(runDir, "test"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	if len(lines) != 2*n {
		t.Fatalf("got %d lines, want %d", len(lines), 2*n)
	}
	next := map[string]int{}
	for _, line := range lines {
		if len(line) < TimestampLen {
			t.Fatalf("line %q has no timestamp prefix", line)
		}
		if _, err := time.Parse(TimestampLayout, line[:TimestampLen-1]); err != nil || line[TimestampLen-1] != ' ' {
			t.Fatalf("line %q: bad timestamp prefix", line)
		}
		line = line[TimestampLen:]
		name := line[:3]
		if want := fmt.Sprintf("%s-%04d-%s", name, next[name], strings.Repeat(name, 10)); line != want {
			t.Fatalf("line %q, want %q", line, want)
		}
		next[name]++
	}
}

func TestPipeStampsEachLineOnce(t *testing.T) {
	runDir := t.TempDir()
	p, err := New(Options{RunDir: runDir, Job: "j", Now: stepClock()})
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprint(p.Stdout(), "a\nb\r\npar")
	fmt.Fprint(p.Stdout(), "tial\n\n")
	fmt.Fprint(p.Stderr(), "tail")
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(LogPath(runDir, "j"))
	want := stamp(0) + "a\n" + stamp(1) + "b\r\n" + stamp(2) + "partial\n" + stamp(3) + "\n" + stamp(4) + "tail"
	if string(data) != want {
		t.Errorf("file = %q, want %q", data, want)
	}
	if len(stamp(0)) != TimestampLen {
		t.Errorf("TimestampLen = %d, prefix is %d bytes", TimestampLen, len(stamp(0)))
	}
}

func TestPipeStampsLongLineOnce(t *testing.T) {
	runDir := t.TempDir()
	p, err := New(Options{RunDir: runDir, Job: "j", Now: stepClock()})
	if err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("x", 3*redact.MaxLine+17)
	fmt.Fprint(p.Stdout(), long+"\nnext\n")
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(LogPath(runDir, "j"))
	if want := stamp(0) + long + "\n" + stamp(1) + "next\n"; string(data) != want {
		t.Fatalf("long line is not stamped exactly once: got %d bytes, want %d", len(data), len(want))
	}
}

func TestPipeStampSkipsRedaction(t *testing.T) {
	r, _ := redact.New([]string{"2026-05-05"}, nil)
	runDir := t.TempDir()
	p, err := New(Options{RunDir: runDir, Job: "j", Redactor: r, Now: stepClock()})
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprint(p.Stdout(), "date 2026-05-05\n")
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(LogPath(runDir, "j"))
	if want := stamp(0) + "date ***\n"; string(data) != want {
		t.Errorf("file = %q, want %q", data, want)
	}
}

func TestPipeStampsBinaryAndDefaultClock(t *testing.T) {
	runDir := t.TempDir()
	p, err := New(Options{RunDir: runDir, Job: "j"})
	if err != nil {
		t.Fatal(err)
	}
	before := time.Now().Add(-time.Second)
	_, _ = p.Stdout().Write([]byte("\x00\xff\x1b[31mred\n"))
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	after := time.Now().Add(time.Second)
	data, _ := os.ReadFile(LogPath(runDir, "j"))
	if !bytes.HasSuffix(data, []byte("Z \x00\xff\x1b[31mred\n")) || len(data) != TimestampLen+len("\x00\xff\x1b[31mred\n") {
		t.Fatalf("file = %q", data)
	}
	at, err := time.Parse(TimestampLayout, string(data[:TimestampLen-1]))
	if err != nil {
		t.Fatal(err)
	}
	if at.Before(before) || at.After(after) {
		t.Errorf("stamp %s outside [%s, %s]", at, before, after)
	}
}
