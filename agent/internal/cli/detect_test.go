package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDetectCommand(t *testing.T) {
	tmpDir := t.TempDir()

	goMod := `module example.com/test

go 1.24
`
	if err := os.WriteFile(filepath.Join(tmpDir, "go.mod"), []byte(goMod), 0o600); err != nil {
		t.Fatalf("WriteFile go.mod failed: %v", err)
	}

	t.Run("detect valid go project", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := Main(context.Background(), []string{"detect", tmpDir}, &stdout, &stderr)
		if code != ExitOK {
			t.Fatalf("exit code = %d, want %d (stderr: %s)", code, ExitOK, stderr.String())
		}
		if !strings.Contains(stdout.String(), "# Detected ecosystem: Go") {
			t.Fatalf("expected Go detected in stdout, got: %q", stdout.String())
		}
		if !strings.Contains(stdout.String(), "go test ./...") {
			t.Fatalf("expected go test in checks, got: %q", stdout.String())
		}
	})

	t.Run("detect empty dir", func(t *testing.T) {
		emptyDir := t.TempDir()
		var stdout, stderr bytes.Buffer
		code := Main(context.Background(), []string{"detect", emptyDir}, &stdout, &stderr)
		if code != ExitNoChecks {
			t.Fatalf("exit code = %d, want %d", code, ExitNoChecks)
		}
		if !strings.Contains(stderr.String(), "no supported project ecosystem detected") {
			t.Fatalf("unexpected stderr: %q", stderr.String())
		}
	})

	t.Run("detect help flag", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := Main(context.Background(), []string{"detect", "-h"}, &stdout, &stderr)
		if code != ExitOK {
			t.Fatalf("exit code = %d, want %d", code, ExitOK)
		}
		if !strings.Contains(stdout.String(), "Usage: zeroci detect") {
			t.Fatalf("unexpected stdout: %q", stdout.String())
		}
	})
}
