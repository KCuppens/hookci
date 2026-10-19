package config

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Severity says whether a Diagnostic blocks the configuration.
type Severity int

const (
	// SeverityError makes the configuration invalid.
	SeverityError Severity = iota
	// SeverityWarning is reported but does not make the configuration invalid.
	SeverityWarning
)

// String returns "error" or "warning".
func (s Severity) String() string {
	if s == SeverityWarning {
		return "warning"
	}
	return "error"
}

// MarshalText encodes the severity as "error" or "warning", which is how it
// appears in zeroci validate --json output.
func (s Severity) MarshalText() ([]byte, error) {
	return []byte(s.String()), nil
}

// Diagnostic is one problem found in a configuration file.
type Diagnostic struct {
	// Path is the dotted location of the problem, for example
	// "checks.jobs.unit.needs[0]". Empty means the whole document.
	Path string `json:"path"`
	// Line is the 1-based line in the source file, or 0 when unknown.
	Line     int      `json:"line"`
	Message  string   `json:"message"`
	Fix      string   `json:"fix,omitempty"`
	Severity Severity `json:"severity"`
}

// Diagnostics is the list of problems found by Parse, sorted by line.
type Diagnostics []Diagnostic

// HasErrors reports whether any diagnostic has SeverityError.
func (d Diagnostics) HasErrors() bool {
	for _, diag := range d {
		if diag.Severity == SeverityError {
			return true
		}
	}
	return false
}

// Format renders the diagnostics for humans, one per entry:
//
//	file:line: error: path: message
//	  fix: ...
//
// The line is omitted when unknown, the path when it is the whole document
// and the fix line when there is no fix.
func (d Diagnostics) Format(file string) string {
	var b strings.Builder
	for _, diag := range d {
		b.WriteString(file)
		if diag.Line > 0 {
			b.WriteString(":")
			b.WriteString(strconv.Itoa(diag.Line))
		}
		b.WriteString(": ")
		b.WriteString(diag.Severity.String())
		b.WriteString(": ")
		if diag.Path != "" {
			b.WriteString(diag.Path)
			b.WriteString(": ")
		}
		b.WriteString(diag.Message)
		b.WriteString("\n")
		if diag.Fix != "" {
			b.WriteString("  fix: ")
			b.WriteString(diag.Fix)
			b.WriteString("\n")
		}
	}
	return b.String()
}

func (d Diagnostics) sort() {
	sort.SliceStable(d, func(i, j int) bool {
		if d[i].Line != d[j].Line {
			return d[i].Line < d[j].Line
		}
		return d[i].Path < d[j].Path
	})
}

// lineIndex maps dotted paths to the source line of the key or sequence
// item that introduces them.
type lineIndex map[string]int

// line returns the line of path, falling back to its nearest ancestor that
// exists in the file (a missing key is reported on its parent's line).
func (li lineIndex) line(path string) int {
	for {
		if n, ok := li[path]; ok {
			return n
		}
		if path == "" {
			return 0
		}
		path = parentPath(path)
	}
}

func (li lineIndex) errorf(path, fix, format string, args ...any) Diagnostic {
	return Diagnostic{Path: path, Line: li.line(path), Message: fmt.Sprintf(format, args...), Fix: fix, Severity: SeverityError}
}

func (li lineIndex) warnf(path, fix, format string, args ...any) Diagnostic {
	return Diagnostic{Path: path, Line: li.line(path), Message: fmt.Sprintf(format, args...), Fix: fix, Severity: SeverityWarning}
}

// joinKey appends a mapping key to a dotted path.
func joinKey(parent, key string) string {
	if parent == "" {
		return key
	}
	return parent + "." + key
}

// joinIndex appends a sequence index to a dotted path.
func joinIndex(parent string, i int) string {
	return parent + "[" + strconv.Itoa(i) + "]"
}

// parentPath strips the last key or index from a dotted path.
func parentPath(path string) string {
	if strings.HasSuffix(path, "]") {
		if i := strings.LastIndexByte(path, '['); i >= 0 {
			return path[:i]
		}
	}
	if i := strings.LastIndexByte(path, '.'); i >= 0 {
		return path[:i]
	}
	return ""
}

// quote quotes a user-supplied value with ASCII-only escapes so diagnostics
// stay plain ASCII whatever the file contains.
func quote(s string) string {
	return strconv.QuoteToASCII(s)
}

func quoteAll(ss []string) string {
	q := make([]string, len(ss))
	for i, s := range ss {
		q[i] = quote(s)
	}
	return strings.Join(q, ", ")
}
