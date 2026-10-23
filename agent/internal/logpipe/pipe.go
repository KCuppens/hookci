// Package logpipe carries a job's output: every line is redacted, stamped with
// the time it was seen, appended to the job's log file (up to MaxLogBytes),
// kept in a tail ring for failure events, mirrored when asked, scanned for
// eslint/tsc diagnostics and for `::hookci step` markers (the first MaxSteps).
package logpipe

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/KCuppens/hookci/agent/internal/redact"
)

const (
	TailLines      = 40
	MaxAnnotations = 50
	// MaxLogBytes caps a job's log file, five times the hub's upload cap
	// (logupload.DefaultMaxBytes). Output past it still reaches the tail,
	// mirror and parsers but is not saved.
	MaxLogBytes = 50 << 20
	// MaxSteps caps the step markers reported to OnStep; later markers are
	// ignored and counted in a note at the end of the log.
	MaxSteps = 500

	// TimestampLayout is the Go layout of the prefix that starts every line of
	// a log file: a UTC time, ISO 8601 with millisecond precision and a literal
	// Z, for example "2026-05-05T14:32:01.123Z". It is the time the pipe
	// received the line's newline (a long-line chunk or a partial line flushed
	// by Close is stamped when it is written). Lines are stamped after
	// redaction, so a redaction pattern cannot change the prefix.
	TimestampLayout = "2006-01-02T15:04:05.000Z"
	// TimestampLen is the width of the prefix on disk: the timestamp and one
	// space, 25 bytes.
	TimestampLen = len(TimestampLayout) + 1
)

// StepEvent reports a `::hookci step <name>` marker.
type StepEvent struct {
	Name  string
	Index int // 1-based
}

// Options configures a Pipe.
type Options struct {
	RunDir   string           // <state>/runs/<run_id>
	Job      string           // job name; the log is LogPath(RunDir, Job)
	Redactor *redact.Redactor // nil: builtins only
	Annotate string           // "", "eslint", "tsc"
	Workdir  string           // absolute src dir; annotation paths made relative to it
	OnStep   func(StepEvent)  // may be nil; called with the pipe locked, so it must not call Pipe methods
	Mirror   io.Writer        // optional extra destination (redacted, without the timestamp prefix), e.g. verbose CLI
	MaxBytes int64            // log file cap; <= 0: MaxLogBytes
	Now      func() time.Time // line clock; nil: time.Now
}

// Pipe is one job's output sink. Stdout and Stderr may be written from
// different goroutines; they are serialized through one mutex, so lines never
// interleave, and both land in the same file in the order received.
type Pipe struct {
	mu           sync.Mutex
	file         *os.File
	written      int64 // bytes in file
	maxBytes     int64
	full         bool // the truncation note is written; nothing more goes to file
	midLine      bool // file does not end with '\n'
	mirror       io.Writer
	now          func() time.Time
	buf          []byte // prefix and line, written to the file in one call
	onStep       func(StepEvent)
	parser       Parser
	workdir      string
	tail         *Ring
	items        []Annotation
	truncated    int
	steps        int
	droppedSteps int
	stdout       *stream
	stderr       *stream
	closed       bool
}

// LogPath is the log file of job in runDir: <runDir>/logs/<job>.log.
func LogPath(runDir, job string) string {
	return filepath.Join(runDir, "logs", job+".log")
}

// New creates <RunDir>/logs (0700) and opens the job's log file (0600) for
// appending; bytes already in it count toward the cap.
func New(o Options) (*Pipe, error) {
	if o.RunDir == "" || o.Job == "" {
		return nil, errors.New("logpipe: RunDir and Job are required")
	}
	path := LogPath(o.RunDir, o.Job)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	maxBytes := o.MaxBytes
	if maxBytes <= 0 {
		maxBytes = MaxLogBytes
	}
	r := o.Redactor
	if r == nil {
		r, _ = redact.New(nil, nil)
	}
	p := &Pipe{
		file:     f,
		written:  fi.Size(),
		maxBytes: maxBytes,
		mirror:   o.Mirror,
		now:      o.Now,
		onStep:   o.OnStep,
		parser:   ParserFor(o.Annotate),
		workdir:  o.Workdir,
		tail:     NewRing(TailLines),
	}
	if p.now == nil {
		p.now = time.Now
	}
	p.stdout = &stream{p: p}
	p.stdout.w = r.Writer(lineSink{p, p.stdout})
	p.stderr = &stream{p: p}
	p.stderr.w = r.Writer(lineSink{p, p.stderr})
	return p, nil
}

// Stdout is the writer for the job's standard output.
func (p *Pipe) Stdout() io.Writer { return p.stdout }

// Stderr is the writer for the job's standard error, merged into the same
// file in the order received.
func (p *Pipe) Stderr() io.Writer { return p.stderr }

// Close flushes partial lines of both streams, notes ignored step markers
// and closes the log file.
func (p *Pipe) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil
	}
	p.closed = true
	err := errors.Join(p.stdout.w.Close(), p.stderr.w.Close())
	if p.droppedSteps > 0 {
		note := p.note(fmt.Sprintf("[hookci: ignored %d step markers past the first %d]\n", p.droppedSteps, MaxSteps))
		err = errors.Join(err, p.writeFile(note))
	}
	return errors.Join(err, p.file.Close())
}

// Tail returns the last TailLines redacted lines, oldest first.
func (p *Pipe) Tail() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.tail.Lines()
}

// Annotations returns the first MaxAnnotations annotations and how many more
// were found.
func (p *Pipe) Annotations() (items []Annotation, truncated int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]Annotation(nil), p.items...), p.truncated
}

// stream is one of the job's output streams with its own line splitter.
type stream struct {
	p   *Pipe
	w   io.WriteCloser // redact.Writer feeding lineSink
	mid bool           // the last piece written to the file did not end its line
}

func (s *stream) Write(b []byte) (int, error) {
	s.p.mu.Lock()
	defer s.p.mu.Unlock()
	return s.w.Write(b)
}

// lineSink receives one redacted line (or long-line chunk) per Write, with
// the pipe locked.
type lineSink struct {
	p *Pipe
	s *stream
}

func (l lineSink) Write(b []byte) (int, error) {
	if err := l.p.handleLine(l.s, b); err != nil {
		return 0, err
	}
	return len(b), nil
}

// handleLine runs with p.mu held. raw is already redacted. The file gets the
// timestamp prefix and raw in one write; the tail ring, the mirror, the
// annotation parser and the step markers see the line without the prefix. A
// piece that continues a line the same stream already started (the next chunk
// of a line over redact.MaxLine bytes) gets no prefix.
func (p *Pipe) handleLine(s *stream, raw []byte) error {
	p.buf = p.buf[:0]
	if !s.mid {
		p.buf = p.stamp(p.buf)
	}
	p.buf = append(p.buf, raw...)
	s.mid = !bytes.HasSuffix(raw, []byte("\n"))
	if err := p.writeFile(p.buf); err != nil {
		return err
	}
	line := string(bytes.TrimSuffix(bytes.TrimSuffix(raw, []byte("\n")), []byte("\r")))
	p.tail.Push(line)
	if p.mirror != nil {
		_, _ = p.mirror.Write(raw) // a broken terminal must not fail the job
	}
	if p.parser != nil {
		if a, ok := p.parser.Feed(line); ok {
			p.addAnnotation(a)
		}
	}
	if name, ok := ParseStepMarker(line); ok {
		if p.steps >= MaxSteps {
			p.droppedSteps++
			return nil
		}
		p.steps++
		if p.onStep != nil {
			p.onStep(StepEvent{Name: name, Index: p.steps})
		}
	}
	return nil
}

// writeFile appends b to the log file unless that would pass maxBytes; then
// it writes the truncation note once and drops b and everything after it.
func (p *Pipe) writeFile(b []byte) error {
	if p.full || len(b) == 0 {
		return nil
	}
	if p.written+int64(len(b)) > p.maxBytes {
		p.full = true
		b = p.note(truncationNote(p.maxBytes))
	}
	n, err := p.file.Write(b)
	p.written += int64(n)
	p.midLine = b[len(b)-1] != '\n'
	return err
}

// stamp appends the timestamp prefix of a line seen now to b.
func (p *Pipe) stamp(b []byte) []byte {
	return append(p.now().UTC().AppendFormat(b, TimestampLayout), ' ')
}

// note is a stamped line the agent writes itself, after a newline that ends
// the file's last line when it is unfinished.
func (p *Pipe) note(text string) []byte {
	var b []byte
	if p.midLine {
		b = append(b, '\n')
	}
	return append(p.stamp(b), text...)
}

// truncationNote ends a log cut at maxBytes.
func truncationNote(maxBytes int64) string {
	if maxBytes >= 1<<20 {
		return fmt.Sprintf("[hookci: log truncated at %d MiB; later output is not saved]\n", maxBytes>>20)
	}
	return fmt.Sprintf("[hookci: log truncated at %d bytes; later output is not saved]\n", maxBytes)
}

func (p *Pipe) addAnnotation(a Annotation) {
	path, ok := relPath(p.workdir, a.Path)
	if !ok {
		return
	}
	if len(p.items) >= MaxAnnotations {
		p.truncated++
		return
	}
	a.Path = path
	p.items = append(p.items, a)
}

// relPath makes an annotation path relative to workdir (slash separated).
// Relative paths are taken as relative to workdir. Paths outside workdir, and
// absolute paths when workdir is unknown, are rejected.
func relPath(workdir, path string) (string, bool) {
	if workdir != "" {
		if !filepath.IsAbs(path) {
			path = filepath.Join(workdir, path)
		}
		rel, err := filepath.Rel(workdir, path)
		if err != nil {
			return "", false
		}
		path = rel
	}
	if !filepath.IsLocal(path) {
		return "", false
	}
	return filepath.ToSlash(filepath.Clean(path)), true
}
