package deploy

import "github.com/bmatcuk/doublestar/v4"

// MatchPaths reports whether any changed file matches any glob. Globs use
// doublestar semantics: * stays within one path segment, ** spans any
// number of them. Empty globs match everything; an invalid glob matches
// nothing.
func MatchPaths(globs, files []string) bool {
	if len(globs) == 0 {
		return true
	}
	for _, f := range files {
		for _, g := range globs {
			if ok, err := doublestar.Match(g, f); err == nil && ok {
				return true
			}
		}
	}
	return false
}
