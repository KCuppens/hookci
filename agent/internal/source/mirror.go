package source

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

// Mirror manages a bare Git repository mirror at <state>/mirrors/<slug>.git.
type Mirror struct {
	Runner    execx.Runner
	RemoteURL string
	MirrorDir string
	Token     string
}

// NewMirror constructs a Mirror instance.
func NewMirror(runner execx.Runner, remoteURL, mirrorDir, token string) *Mirror {
	if runner == nil {
		runner = execx.OS{}
	}
	return &Mirror{
		Runner:    runner,
		RemoteURL: remoteURL,
		MirrorDir: mirrorDir,
		Token:     token,
	}
}

// Sync ensures the bare mirror exists and is updated with the latest remote refs.
func (m *Mirror) Sync(ctx context.Context) error {
	askPass, err := NewAskPass(m.Token)
	if err != nil {
		return fmt.Errorf("setup askpass: %w", err)
	}
	defer askPass.Cleanup()

	env := append(os.Environ(), askPass.Env()...)

	headPath := filepath.Join(m.MirrorDir, "HEAD")
	if _, err := os.Stat(headPath); os.IsNotExist(err) {
		// Create parent directory
		if err := os.MkdirAll(filepath.Dir(m.MirrorDir), 0o755); err != nil {
			return fmt.Errorf("create mirror parent dir: %w", err)
		}

		cmd := execx.Cmd{
			Name: "git",
			Args: []string{"clone", "--mirror", m.RemoteURL, m.MirrorDir},
			Env:  env,
		}
		if err := m.Runner.Run(ctx, cmd); err != nil {
			return fmt.Errorf("git clone --mirror: %w", err)
		}
		return nil
	}

	// Mirror exists: update refs
	cmd := execx.Cmd{
		Name: "git",
		Args: []string{"-C", m.MirrorDir, "fetch", "--prune", "origin", "+refs/*:refs/*"},
		Env:  env,
	}
	if err := m.Runner.Run(ctx, cmd); err != nil {
		return fmt.Errorf("git fetch --prune: %w", err)
	}

	return nil
}

// SharedClone creates an ephemeral workspace at targetDir sharing the mirror's object database
// via git clone --shared, and checks out the requested ref or commit.
func (m *Mirror) SharedClone(ctx context.Context, targetDir, refOrCommit string) (*Checkout, error) {
	if refOrCommit == "" {
		refOrCommit = "HEAD"
	}

	if err := os.MkdirAll(filepath.Dir(targetDir), 0o755); err != nil {
		return nil, fmt.Errorf("create target parent dir: %w", err)
	}

	cloneCmd := execx.Cmd{
		Name: "git",
		Args: []string{"clone", "--shared", m.MirrorDir, targetDir},
	}
	if err := m.Runner.Run(ctx, cloneCmd); err != nil {
		return nil, fmt.Errorf("git clone --shared: %w", err)
	}

	checkoutCmd := execx.Cmd{
		Name: "git",
		Args: []string{"-C", targetDir, "checkout", refOrCommit},
	}
	if err := m.Runner.Run(ctx, checkoutCmd); err != nil {
		return nil, fmt.Errorf("git checkout %s: %w", refOrCommit, err)
	}

	var stdout bytes.Buffer
	revCmd := execx.Cmd{
		Name:   "git",
		Args:   []string{"-C", targetDir, "rev-parse", "HEAD"},
		Stdout: &stdout,
	}
	if err := m.Runner.Run(ctx, revCmd); err != nil {
		return nil, fmt.Errorf("git rev-parse HEAD: %w", err)
	}

	commit := strings.TrimSpace(stdout.String())
	return &Checkout{
		Dir:    targetDir,
		Commit: commit,
	}, nil
}
