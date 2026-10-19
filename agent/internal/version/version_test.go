package version

import "testing"

func TestStringWithoutCommit(t *testing.T) {
	origVersion, origCommit := Version, Commit
	defer func() { Version, Commit = origVersion, origCommit }()

	Version, Commit = "dev", ""

	if got, want := String(), "zeroci dev"; got != want {
		t.Fatalf("String() = %q, want %q", got, want)
	}
}

func TestStringWithCommit(t *testing.T) {
	origVersion, origCommit := Version, Commit
	defer func() { Version, Commit = origVersion, origCommit }()

	Version, Commit = "v1.2.3", "abcdef0"

	if got, want := String(), "zeroci v1.2.3 (abcdef0)"; got != want {
		t.Fatalf("String() = %q, want %q", got, want)
	}
}
