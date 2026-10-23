// Package redact masks secrets in job output before it is written anywhere.
//
// Redaction works line by line: literal secret values and secrets registered
// with AddSecret are replaced first (longest first), then the built-in token
// patterns and the config `redact:`
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
	"sync"
	"sync/atomic"
	"time"
)

// Mask replaces every redacted value.
const Mask = "***"

// MinSecretLen is the shortest literal value that is redacted. Shorter values
// would mask ordinary words and numbers all over the log.
const MinSecretLen = 4

// MaxLine is the longest line Writer holds. Longer lines are flushed in
// chunks of at most MaxLine bytes, each redacted on its own. A chunk never
// ends inside a literal, registered secret or pattern match found in the
// MaxLine window, and the last cutOverlap bytes (or the longest secret, if
// longer) of the window wait for the next chunk, so a secret of up to that
// length that straddles the window end is still masked whole.
const MaxLine = 64 << 10

// cutOverlap is the least a long-line chunk holds back for the next one; it
// covers tokens such as JWTs that only match once they are complete.
const cutOverlap = 8 << 10

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

// With returns a redactor that masks everything r masks plus literals.
// Literal values shorter than MinSecretLen are skipped.
func (r *Redactor) With(literals []string) *Redactor {
	out, _ := New(slices.Concat(r.literals, literals), nil)
	out.patterns = r.patterns
	return out
}

// Line returns s with every literal, registered secret (AddSecret) and
// pattern match replaced by Mask.
func (r *Redactor) Line(s string) string {
	for _, v := range r.literals {
		s = strings.ReplaceAll(s, v, Mask)
	}
	if reg := registry.Load(); reg != nil {
		for _, sec := range *reg {
			s = strings.ReplaceAll(s, sec.value, Mask)
		}
	}
	for _, p := range r.patterns {
		s = p.ReplaceAllString(s, Mask)
	}
	return s
}

type secret struct {
	value string
	exp   time.Time
}

var (
	registryMu sync.Mutex
	registry   atomic.Pointer[[]secret] // longest first; replaced on every change
)

// AddSecret makes every Redactor in the process mask v from now on, for
// values learned at run time such as hub-issued fetch tokens. exp is when v
// stops being valid; expired values are dropped by later calls. Values
// shorter than MinSecretLen are ignored.
func AddSecret(v string, exp time.Time) {
	if len(v) < MinSecretLen {
		return
	}
	registryMu.Lock()
	defer registryMu.Unlock()
	var cur []secret
	if p := registry.Load(); p != nil {
		cur = *p
	}
	now := time.Now()
	next := make([]secret, 0, len(cur)+1)
	for _, s := range cur {
		if s.value != v && s.exp.After(now) {
			next = append(next, s)
		}
	}
	next = append(next, secret{value: v, exp: exp})
	slices.SortStableFunc(next, func(a, b secret) int { return len(b.value) - len(a.value) })
	registry.Store(&next)
}

// Writer returns a line-buffered io.WriteCloser; partial lines are held until
// '\n' or Close. Lines longer than MaxLine are flushed in chunks of at most
// MaxLine bytes (each chunk redacted, cut so it does not split a secret; see
// MaxLine). Every redacted line (with its '\n') or chunk reaches dst in
// exactly one Write call. A trailing '\r' is kept out of matching and
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
			n := w.r.cut(rest[:MaxLine])
			if err := w.emit(rest[:n], false); err != nil {
				return len(p), err
			}
			start += n
		default:
			w.buf = append(w.buf[:0], rest...)
			return len(p), nil
		}
	}
}

// cut returns how much of win, a MaxLine window of a longer line, to emit as
// one chunk: win minus the hold-back overlap, moved back to the start of any
// literal, registered secret or pattern match that would straddle it. When
// that leaves nothing, a single match fills most of win and win goes whole.
func (r *Redactor) cut(win []byte) int {
	s := string(win)
	hold := cutOverlap
	if len(r.literals) > 0 {
		hold = max(hold, len(r.literals[0])-1)
	}
	var reg []secret
	if p := registry.Load(); p != nil {
		reg = *p
	}
	if len(reg) > 0 {
		hold = max(hold, len(reg[0].value)-1)
	}
	c := len(win) - min(hold, len(win)/2)

	var spans [][2]int
	literal := func(v string) {
		for off := 0; ; {
			i := strings.Index(s[off:], v)
			if i < 0 {
				return
			}
			spans = append(spans, [2]int{off + i, off + i + len(v)})
			off += i + 1
		}
	}
	for _, v := range r.literals {
		literal(v)
	}
	for _, sec := range reg {
		literal(sec.value)
	}
	for _, p := range r.patterns {
		for _, m := range p.FindAllStringIndex(s, -1) {
			spans = append(spans, [2]int{m[0], m[1]})
		}
	}
	for moved := true; moved && c > 0; {
		moved = false
		for _, sp := range spans {
			if sp[0] < c && c < sp[1] {
				c, moved = sp[0], true
			}
		}
	}
	if c <= 0 {
		return len(win)
	}
	return c
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
