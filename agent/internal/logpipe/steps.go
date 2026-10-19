package logpipe

import (
	"regexp"
	"strings"
)

var stepMarker = regexp.MustCompile(`^::zeroci step (.{1,80})$`)

// ParseStepMarker reports whether line is a `::zeroci step <name>` marker
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
// of lines that print a `::zeroci step ` marker. A marker printed in a loop
// counts once, so callers take the larger of this and the step index.
func CountStepMarkers(script string) int {
	n := 0
	for line := range strings.Lines(script) {
		if strings.Contains(line, "::zeroci step ") {
			n++
		}
	}
	return n
}
