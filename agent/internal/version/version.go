// Package version holds the build-time version metadata for the zeroci
// binary. Version and Commit are overridden at build time via -ldflags
// (see the Makefile and .goreleaser.yaml):
//
//	go build -ldflags "-X .../version.Version=1.2.3 -X .../version.Commit=abcdef0"
package version

import (
	"strconv"
	"strings"
)

// Version is the zeroci release version. Defaults to "dev" for local,
// non-release builds.
var Version = "dev"

// Commit is the git commit the binary was built from. Empty for local,
// non-release builds.
var Commit = ""

// String returns the human-readable version string, e.g. "zeroci dev" or
// "zeroci 1.2.3 (abcdef0)" when Commit is set.
func String() string {
	s := "zeroci " + Version
	if Commit != "" {
		s += " (" + Commit + ")"
	}
	return s
}

// Compare orders two semantic versions, with or without a leading "v",
// and returns -1, 0 or +1. "dev" and any string that is not a semantic
// version sort below every release and equal to each other. Build metadata
// is ignored; a prerelease sorts below its release.
func Compare(a, b string) int {
	va, okA := parse(a)
	vb, okB := parse(b)
	switch {
	case !okA && !okB:
		return 0
	case !okA:
		return -1
	case !okB:
		return 1
	}
	for i := range va.core {
		if c := cmpInt(va.core[i], vb.core[i]); c != 0 {
			return c
		}
	}
	return comparePre(va.pre, vb.pre)
}

type semver struct {
	core [3]uint64
	pre  []string
}

func parse(s string) (semver, bool) {
	s = strings.TrimPrefix(s, "v")
	if i := strings.IndexByte(s, '+'); i >= 0 {
		s = s[:i]
	}
	var v semver
	core, pre, hasPre := strings.Cut(s, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return semver{}, false
	}
	for i, p := range parts {
		n, ok := numeric(p)
		if !ok {
			return semver{}, false
		}
		v.core[i] = n
	}
	if hasPre {
		v.pre = strings.Split(pre, ".")
		for _, id := range v.pre {
			if id == "" {
				return semver{}, false
			}
		}
	}
	return v, true
}

// numeric parses a semver numeric identifier: digits, no leading zero.
func numeric(s string) (uint64, bool) {
	if s == "" || (len(s) > 1 && s[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(s, 10, 64)
	return n, err == nil
}

// comparePre applies semver precedence to prerelease identifiers: none
// beats any; numeric identifiers sort below alphanumeric ones.
func comparePre(a, b []string) int {
	switch {
	case len(a) == 0 && len(b) == 0:
		return 0
	case len(a) == 0:
		return 1
	case len(b) == 0:
		return -1
	}
	for i := 0; i < len(a) && i < len(b); i++ {
		na, numA := numeric(a[i])
		nb, numB := numeric(b[i])
		var c int
		switch {
		case numA && numB:
			c = cmpInt(na, nb)
		case numA:
			c = -1
		case numB:
			c = 1
		default:
			c = strings.Compare(a[i], b[i])
		}
		if c != 0 {
			return c
		}
	}
	return cmpInt(uint64(len(a)), uint64(len(b)))
}

func cmpInt(a, b uint64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}
