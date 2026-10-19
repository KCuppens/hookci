package redact

import (
	"bytes"
	"io"
	"sort"
	"strings"
	"sync"
)

// Redactor masks registered sensitive strings before they touch disk or output streams.
type Redactor struct {
	mu      sync.RWMutex
	secrets []string
}

// New constructs an empty Redactor.
func New(secrets ...string) *Redactor {
	r := &Redactor{}
	r.Add(secrets...)
	return r
}

// Add registers secrets to be masked. Empty secrets or secrets shorter than 4 characters
// are ignored to avoid unintentional masking of common sub-tokens.
func (r *Redactor) Add(secrets ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, s := range secrets {
		s = strings.TrimSpace(s)
		if len(s) < 4 {
			continue
		}
		// Avoid duplicate entries
		found := false
		for _, existing := range r.secrets {
			if existing == s {
				found = true
				break
			}
		}
		if !found {
			r.secrets = append(r.secrets, s)
		}
	}

	// Sort secrets by descending length so longer tokens match first
	sort.Slice(r.secrets, func(i, j int) bool {
		return len(r.secrets[i]) > len(r.secrets[j])
	})
}

// Redact replaces all registered secrets in s with "***".
func (r *Redactor) Redact(s string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if len(r.secrets) == 0 {
		return s
	}

	result := s
	for _, secret := range r.secrets {
		result = strings.ReplaceAll(result, secret, "***")
	}
	return result
}

// Writer returns an io.WriteCloser that buffers incoming chunks into lines,
// redacts each line, and forwards to target.
func (r *Redactor) Writer(target io.Writer) io.WriteCloser {
	return &lineWriter{
		redactor: r,
		target:   target,
	}
}

type lineWriter struct {
	mu       sync.Mutex
	redactor *Redactor
	target   io.Writer
	buf      bytes.Buffer
}

func (w *lineWriter) Write(p []byte) (n int, err error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	total := len(p)
	for len(p) > 0 {
		idx := bytes.IndexByte(p, '\n')
		if idx == -1 {
			w.buf.Write(p)
			break
		}

		w.buf.Write(p[:idx+1])
		line := w.buf.String()
		w.buf.Reset()

		redacted := w.redactor.Redact(line)
		if _, err := io.WriteString(w.target, redacted); err != nil {
			return 0, err
		}
		p = p[idx+1:]
	}

	return total, nil
}

func (w *lineWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.buf.Len() > 0 {
		line := w.buf.String()
		w.buf.Reset()
		redacted := w.redactor.Redact(line)
		if _, err := io.WriteString(w.target, redacted); err != nil {
			return err
		}
	}

	if closer, ok := w.target.(io.Closer); ok {
		return closer.Close()
	}
	return nil
}
