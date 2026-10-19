package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateCommand(t *testing.T) {
	tmpDir := t.TempDir()

	validConfig := `
version: 1
checks:
  setup:
    - run: echo setup
  jobs:
    lint:
      run: npm run lint
    test:
      run: npm test
      needs: [lint]
`
	validPath := filepath.Join(tmpDir, ".zeroci.yml")
	if err := os.WriteFile(validPath, []byte(validConfig), 0o600); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	invalidConfig := `
version: 1
checks:
  jobs:
    lint:
      run: echo lint
      needs: [lint]
`
	invalidPath := filepath.Join(tmpDir, "invalid.yml")
	if err := os.WriteFile(invalidPath, []byte(invalidConfig), 0o600); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	t.Run("valid positional arg", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := Main([]string{"validate", validPath}, &stdout, &stderr)
		if code != ExitOK {
			t.Fatalf("exit code = %d, want %d (stderr: %s)", code, ExitOK, stderr.String())
		}
		if !strings.Contains(stdout.String(), "valid configuration (2 check jobs)") {
			t.Fatalf("unexpected stdout: %q", stdout.String())
		}
	})

	t.Run("valid -f flag", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := Main([]string{"validate", "-f", validPath}, &stdout, &stderr)
		if code != ExitOK {
			t.Fatalf("exit code = %d, want %d (stderr: %s)", code, ExitOK, stderr.String())
		}
		if !strings.Contains(stdout.String(), "valid configuration (2 check jobs)") {
			t.Fatalf("unexpected stdout: %q", stdout.String())
		}
	})

	t.Run("invalid config", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := Main([]string{"validate", invalidPath}, &stdout, &stderr)
		if code != ExitUsage {
			t.Fatalf("exit code = %d, want %d", code, ExitUsage)
		}
		if !strings.Contains(stderr.String(), "invalid configuration") {
			t.Fatalf("unexpected stderr: %q", stderr.String())
		}
	})

	t.Run("file not found", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := Main([]string{"validate", filepath.Join(tmpDir, "nonexistent.yml")}, &stdout, &stderr)
		if code != ExitUsage {
			t.Fatalf("exit code = %d, want %d", code, ExitUsage)
		}
		if !strings.Contains(stderr.String(), "no such file or directory") {
			t.Fatalf("unexpected stderr: %q", stderr.String())
		}
	})

	t.Run("help flag", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := Main([]string{"validate", "-h"}, &stdout, &stderr)
		if code != ExitOK {
			t.Fatalf("exit code = %d, want %d", code, ExitOK)
		}
		if !strings.Contains(stdout.String(), "Usage: zeroci validate") {
			t.Fatalf("unexpected stdout: %q", stdout.String())
		}
	})
}
