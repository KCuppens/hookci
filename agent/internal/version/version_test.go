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

	Version, Commit = "1.2.3", "abcdef0"

	if got, want := String(), "zeroci 1.2.3 (abcdef0)"; got != want {
		t.Fatalf("String() = %q, want %q", got, want)
	}
}

func TestCompare(t *testing.T) {
	tests := []struct {
		a, b string
		want int
	}{
		{"dev", "dev", 0},
		{"dev", "0.0.1", -1},
		{"v0.1.0", "dev", 1},
		{"dev", "v0.1.0-rc.1", -1},
		{"garbage", "dev", 0},
		{"1.2.3", "v1.2.3", 0},
		{"1.2.3", "1.2.4", -1},
		{"1.2.10", "1.2.9", 1},
		{"1.3.0", "1.2.99", 1},
		{"2.0.0", "1.99.99", 1},
		{"1.2.3-rc.1", "1.2.3", -1},
		{"1.2.3", "1.2.3-rc.1", 1},
		{"1.2.3-rc.1", "1.2.3-rc.2", -1},
		{"1.2.3-rc.2", "1.2.3-rc.10", -1},
		{"1.2.3-alpha", "1.2.3-alpha.1", -1},
		{"1.2.3-alpha.1", "1.2.3-beta", -1},
		{"1.2.3-1", "1.2.3-alpha", -1},
		{"1.2.3-rc.1", "1.2.2", 1},
		{"1.2.3+build.5", "1.2.3", 0},
	}
	for _, tt := range tests {
		if got := Compare(tt.a, tt.b); got != tt.want {
			t.Errorf("Compare(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
		}
	}
}
