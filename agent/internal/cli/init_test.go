package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInitCommand(t *testing.T) {
	tmpDir := t.TempDir()

	cargoToml := `[package]
name = "rust-app"
version = "0.1.0"
edition = "2021"
`
	if err := os.WriteFile(filepath.Join(tmpDir, "Cargo.toml"), []byte(cargoToml), 0o600); err != nil {
		t.Fatalf("WriteFile Cargo.toml failed: %v", err)
	}

	t.Run("init creates .zeroci.yml", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := Main([]string{"init", tmpDir}, &stdout, &stderr)
		if code != ExitOK {
			t.Fatalf("exit code = %d, want %d (stderr: %s)", code, ExitOK, stderr.String())
		}
		if !strings.Contains(stdout.String(), "Initialized") || !strings.Contains(stdout.String(), "Rust detected") {
			t.Fatalf("unexpected stdout: %q", stdout.String())
		}

		targetFile := filepath.Join(tmpDir, ".zeroci.yml")
		data, err := os.ReadFile(targetFile)
		if err != nil {
			t.Fatalf("failed to read created config: %v", err)
		}
		if !strings.Contains(string(data), "cargo test") {
			t.Fatalf("expected cargo test in config, got:\n%s", string(data))
		}
	})

	t.Run("init fails if file exists without --force", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := Main([]string{"init", tmpDir}, &stdout, &stderr)
		if code != ExitUsage {
			t.Fatalf("exit code = %d, want %d", code, ExitUsage)
		}
		if !strings.Contains(stderr.String(), "already exists (use --force to overwrite)") {
			t.Fatalf("unexpected stderr: %q", stderr.String())
		}
	})

	t.Run("init overwrites with --force", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := Main([]string{"init", "--force", tmpDir}, &stdout, &stderr)
		if code != ExitOK {
			t.Fatalf("exit code = %d, want %d (stderr: %s)", code, ExitOK, stderr.String())
		}
		if !strings.Contains(stdout.String(), "Initialized") {
			t.Fatalf("unexpected stdout: %q", stdout.String())
		}
	})

	t.Run("init fails on empty dir", func(t *testing.T) {
		emptyDir := t.TempDir()
		var stdout, stderr bytes.Buffer
		code := Main([]string{"init", emptyDir}, &stdout, &stderr)
		if code != ExitNoChecks {
			t.Fatalf("exit code = %d, want %d", code, ExitNoChecks)
		}
		if !strings.Contains(stderr.String(), "no supported project ecosystem detected") {
			t.Fatalf("unexpected stderr: %q", stderr.String())
		}
	})

	t.Run("init help flag", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := Main([]string{"init", "-h"}, &stdout, &stderr)
		if code != ExitOK {
			t.Fatalf("exit code = %d, want %d", code, ExitOK)
		}
		if !strings.Contains(stdout.String(), "Usage: zeroci init") {
			t.Fatalf("unexpected stdout: %q", stdout.String())
		}
	})
}
