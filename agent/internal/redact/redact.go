// Package redact masks secrets in job output before it is written anywhere.
//
// Redaction works line by line: literal secret values are replaced first
// (longest first), then the built-in token patterns and the config `redact:`
// patterns. It is best effort on line boundaries: a secret that contains a
// newline, or that a job prints split across two lines, is not caught.
package redact

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strings"
)

// Mask replaces every redacted value.
const Mask = "***"

// MinSecretLen is the shortest literal value that is redacted. Shorter values
// would mask ordinary words and numbers all over the log.
const MinSecretLen = 4

// MaxLine is the longest line Writer holds. Longer lines are flushed in
// MaxLine chunks, each redacted on its own.
const MaxLine = 64 << 10

// Builtins are always on.
var Builtins = []string{
	`ghs_[A-Za-z0-9]{20,}`,
	`ghp_[A-Za-z0-9]{20,}`,
	`github_pat_[A-Za-z0-9_]{20,}`,
	`xox[bpas]-[A-Za-z0-9-]{10,}`,
	`AKIA[0-9A-Z]{16}`,
	`(?i)aws_secret_access_key\s*[=:]\s*\S+`,
	`eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`, // JWT
}

var builtins = func() []*regexp.Regexp {
	out := make([]*regexp.Regexp, len(Builtins))
	for i, p := range Builtins {
		out[i] = regexp.MustCompile(p)
	}
	return out
}()

// Redactor masks literal values and patterns in lines. It is safe for
// concurrent use.
type Redactor struct {
	literals []string // longest first
	patterns []*regexp.Regexp
}

// New builds a redactor from literal secret values and extra patterns (the
// config `redact:` list); Builtins are always added. Literal values shorter
// than MinSecretLen are skipped and reported in warnings
// ("redact: skipping value of length N from literals[i]"); empty values are
// skipped silently.
func New(literals []string, patterns []*regexp.Regexp) (r *Redactor, warnings []string) {
	r = &Redactor{patterns: slices.Concat(builtins, patterns)}
	seen := make(map[string]bool, len(literals))
	for i, v := range literals {
		switch {
		case v == "" || seen[v]:
			continue
		case len(v) < MinSecretLen:
			warnings = append(warnings, fmt.Sprintf("redact: skipping value of length %d from literals[%d]", len(v), i))
			continue
		}
		seen[v] = true
		r.literals = append(r.literals, v)
	}
	slices.SortStableFunc(r.literals, func(a, b string) int { return len(b) - len(a) })
	return r, warnings
}

// Line returns s with every literal and pattern match replaced by Mask.
func (r *Redactor) Line(s string) string {
	for _, v := range r.literals {
		s = strings.ReplaceAll(s, v, Mask)
	}
	for _, p := range r.patterns {
		s = p.ReplaceAllString(s, Mask)
	}
	return s
}

// Writer returns a line-buffered io.WriteCloser; partial lines are held until
// '\n' or Close. Lines longer than 64 KiB are flushed in 64 KiB chunks (each
// chunk redacted). Every redacted line (with its '\n') or chunk reaches dst
// in exactly one Write call. A trailing '\r' is kept out of matching and
// restored on output. Close flushes the partial line and does not close dst.
// The writer is not safe for concurrent use.
func (r *Redactor) Writer(dst io.Writer) io.WriteCloser {
	return &writer{r: r, dst: dst}
}

var errClosed = errors.New("redact: write after close")

type writer struct {
	r      *Redactor
	dst    io.Writer
	buf    []byte
	out    []byte
	closed bool
}

func (w *writer) Write(p []byte) (int, error) {
	if w.closed {
		return 0, errClosed
	}
	w.buf = append(w.buf, p...)
	start := 0
	for {
		rest := w.buf[start:]
		i := bytes.IndexByte(rest, '\n')
		switch {
		case i >= 0 && i <= MaxLine:
			if err := w.emit(rest[:i], true); err != nil {
				return len(p), err
			}
			start += i + 1
		case len(rest) > MaxLine:
			if err := w.emit(rest[:MaxLine], false); err != nil {
				return len(p), err
			}
			start += MaxLine
		default:
			w.buf = append(w.buf[:0], rest...)
			return len(p), nil
		}
	}
}

func (w *writer) Close() error {
	if w.closed {
		return nil
	}
	w.closed = true
	if len(w.buf) == 0 {
		return nil
	}
	err := w.emit(w.buf, false)
	w.buf = nil
	return err
}

// emit redacts one line (newline true) or one unterminated piece and writes
// it to dst in a single call.
func (w *writer) emit(line []byte, newline bool) error {
	cr := newline && len(line) > 0 && line[len(line)-1] == '\r'
	if cr {
		line = line[:len(line)-1]
	}
	w.out = append(w.out[:0], w.r.Line(string(line))...)
	if cr {
		w.out = append(w.out, '\r')
	}
	if newline {
		w.out = append(w.out, '\n')
	}
	_, err := w.dst.Write(w.out)
	return err
}
