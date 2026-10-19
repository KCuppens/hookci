package source

import (
	"fmt"
	"os"
	"path/filepath"
)

// AskPass manages a transient executable script for GIT_ASKPASS credential injection.
type AskPass struct {
	scriptPath string
	tmpDir     string
}

// NewAskPass creates a secure temporary executable that outputs the provided token.
// The caller MUST call Cleanup() when git operations are finished.
func NewAskPass(token string) (*AskPass, error) {
	if token == "" {
		return &AskPass{}, nil
	}

	tmpDir, err := os.MkdirTemp("", "zeroci-askpass-*")
	if err != nil {
		return nil, fmt.Errorf("create askpass temp dir: %w", err)
	}

	scriptPath := filepath.Join(tmpDir, "askpass.sh")
	content := fmt.Sprintf("#!/bin/sh\ncat <<'EOF'\n%s\nEOF\n", token)

	if err := os.WriteFile(scriptPath, []byte(content), 0o700); err != nil {
		_ = os.RemoveAll(tmpDir)
		return nil, fmt.Errorf("write askpass script: %w", err)
	}

	return &AskPass{
		scriptPath: scriptPath,
		tmpDir:     tmpDir,
	}, nil
}

// Env returns the environment variables to inject for git commands.
func (a *AskPass) Env() []string {
	if a == nil || a.scriptPath == "" {
		return []string{
			"GIT_TERMINAL_PROMPT=0",
		}
	}
	return []string{
		"GIT_ASKPASS=" + a.scriptPath,
		"GIT_TERMINAL_PROMPT=0",
	}
}

// Cleanup removes the temporary askpass script and directory.
func (a *AskPass) Cleanup() {
	if a != nil && a.tmpDir != "" {
		_ = os.RemoveAll(a.tmpDir)
		a.tmpDir = ""
		a.scriptPath = ""
	}
}
