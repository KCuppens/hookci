package logpipe

import (
	"regexp"
	"strings"
)

var stepMarker = regexp.MustCompile(`^::hookci step (.{1,80})$`)

// ParseStepMarker reports whether line is a `::hookci step <name>` marker
// (surrounding whitespace ignored, name 1 to 80 characters) and returns the
// step name.
func ParseStepMarker(line string) (name string, ok bool) {
	m := stepMarker.FindStringSubmatch(strings.TrimSpace(line))
	if m == nil {
		return "", false
	}
	return m[1], true
}

// CountStepMarkers estimates a job's step total from its script: the number
// of lines that print a `::hookci step ` marker. A marker printed in a loop
// counts once, so callers take the larger of this and the step index.
func CountStepMarkers(script string) int {
	n := 0
	for line := range strings.Lines(script) {
		if strings.Contains(line, "::hookci step ") {
			n++
		}
	}
	return n
}
