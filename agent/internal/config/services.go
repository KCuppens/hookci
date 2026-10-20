package config

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// postgresImageRe accepts only the official postgres image, by its short or
// fully qualified name, pinned by a tag, a digest or both.
var postgresImageRe = regexp.MustCompile(
	`^(?:(?:docker\.io/)?library/)?postgres(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}(?:@sha256:[a-f0-9]{64})?|@sha256:[a-f0-9]{64})$`)

// ValidPostgresImage reports whether image is the official postgres image
// (postgres, library/postgres or docker.io/library/postgres) with a tag or
// digest. The agent pulls and runs this image, so no other is accepted.
func ValidPostgresImage(image string) bool {
	return postgresImageRe.MatchString(image)
}

// SplitCachePath maps a setup cache path onto its base directory: "~" and
// "~/x" are under the job's home (home is true), anything else is under the
// checkout. rel is the cleaned path below the base, "." for "~" itself. A path
// that leaves its base, or names the checkout itself, is an error.
func SplitCachePath(p string) (home bool, rel string, err error) {
	rest := p
	switch {
	case p == "~":
		return true, ".", nil
	case strings.HasPrefix(p, "~/"):
		home, rest = true, p[2:]
	}
	rel = filepath.Clean(rest)
	if !filepath.IsLocal(rel) || rel == "." {
		base := "repository"
		if home {
			base = "home"
		}
		return false, "", fmt.Errorf("cache path %s is not inside the %s directory", quote(p), base)
	}
	return home, rel, nil
}
