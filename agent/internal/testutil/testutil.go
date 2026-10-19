// Package testutil provides shared test helpers for the zeroci agent.
package testutil

import (
	"bytes"
	"flag"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

var update = flag.Bool("update", false, "update golden files")

// RequireIntegration skips the test unless it is running on Linux as root
// with ZEROCI_INTEGRATION=1 set. Integration tests exercise privileged
// operations (process credentials, real filesystem layouts) that only make
// sense on a disposable Linux VM running as root.
func RequireIntegration(t testing.TB) {
	t.Helper()

	if os.Getenv("ZEROCI_INTEGRATION") != "1" {
		t.Skip("skipping integration test: set ZEROCI_INTEGRATION=1 to run")
	}
	if runtime.GOOS != "linux" {
		t.Skipf("skipping integration test: requires linux, running on %s", runtime.GOOS)
	}
	if os.Geteuid() != 0 {
		t.Skip("skipping integration test: requires root")
	}
}

// Golden compares got against the golden file testdata/<name>.golden,
// failing with a readable diff on mismatch. Run tests with -update to
// (re)write the golden file from got.
func Golden(t testing.TB, name string, got []byte) {
	t.Helper()
	GoldenFile(t, filepath.Join("testdata", name+".golden"), got)
}

// GoldenFile is Golden for a golden file at an explicit path, for goldens
// that live outside testdata (for example the detection fixtures).
func GoldenFile(t testing.TB, path string, got []byte) {
	t.Helper()

	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("Golden: creating testdata dir: %v", err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatalf("Golden: writing %s: %v", path, err)
		}
		return
	}

	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("Golden: reading %s: %v (run with -update to create it)", path, err)
	}

	if !bytes.Equal(got, want) {
		t.Fatalf("Golden: %s mismatch\n--- want ---\n%s\n--- got ---\n%s", path, want, got)
	}
}
