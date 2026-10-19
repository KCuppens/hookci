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
