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

	"github.com/KCuppens/zerocideploy/agent/internal/redact"
)

func TestPipeWritesRedactedFile(t *testing.T) {
	const secret = "hunter2-very-secret"
	r, _ := redact.New([]string{secret}, nil)
	runDir := t.TempDir()
	var mirror bytes.Buffer
	p, err := New(Options{RunDir: runDir, Job: "test", Redactor: r, Mirror: &mirror})
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
	if want := "login with ***\nerror: bad token ***\nunterminated ***"; string(data) != want {
		t.Errorf("file = %q, want %q", data, want)
	}
	if mirror.String() != string(data) {
		t.Errorf("mirror = %q, want the redacted file bytes", mirror.String())
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
	fmt.Fprint(p.Stdout(), "::zeroci step install\nnpm ci\n  ::zeroci step build  \n::zeroci step \n")
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	want := []StepEvent{{Name: "install", Index: 1}, {Name: "build", Index: 2}}
	if !slices.Equal(steps, want) {
		t.Errorf("steps = %+v, want %+v", steps, want)
	}
	data, _ := os.ReadFile(LogPath(runDir, "build"))
	if !strings.Contains(string(data), "::zeroci step install\n") {
		t.Errorf("marker line missing from log: %q", data)
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
		name := line[:3]
		if want := fmt.Sprintf("%s-%04d-%s", name, next[name], strings.Repeat(name, 10)); line != want {
			t.Fatalf("line %q, want %q", line, want)
		}
		next[name]++
	}
}
