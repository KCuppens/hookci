// Package version holds the build-time version metadata for the zeroci
// binary. Version and Commit are intended to be overridden at build time
// via -ldflags, for example:
//
//	go build -ldflags "-X .../version.Version=v1.2.3 -X .../version.Commit=abcdef0"
package version

// Version is the zeroci release version. Defaults to "dev" for local,
// non-release builds.
var Version = "dev"

// Commit is the short git commit hash the binary was built from. Empty for
// local, non-release builds.
var Commit = ""

// String returns the human-readable version string, e.g. "zeroci dev" or
// "zeroci v1.2.3 (abcdef0)" when Commit is set.
func String() string {
	s := "zeroci " + Version
	if Commit != "" {
		s += " (" + Commit + ")"
	}
	return s
}
