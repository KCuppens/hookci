package source

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

// LocalSource implements Source for a local directory or repository on disk.
type LocalSource struct {
	Runner       execx.Runner
	SrcDir       string
	Ref          string
	SyncWorktree bool
}

// NewLocalSource constructs a LocalSource.
func NewLocalSource(runner execx.Runner, srcDir, ref string) *LocalSource {
	if runner == nil {
		runner = execx.OS{}
	}
	return &LocalSource{
		Runner:       runner,
		SrcDir:       srcDir,
		Ref:          ref,
		SyncWorktree: true,
	}
}

// Prepare checks out the source into targetDir. If SrcDir is a git repository,
// it uses git clone --shared for instant copy-on-write object sharing, and copies
// any uncommitted changes if SyncWorktree is enabled. If not a git repo, it copies
// directory contents.
func (s *LocalSource) Prepare(ctx context.Context, targetDir string) (*Checkout, error) {
	if s.SrcDir == "" {
		return nil, fmt.Errorf("source directory cannot be empty")
	}

	absSrc, err := filepath.Abs(s.SrcDir)
	if err != nil {
		return nil, fmt.Errorf("resolve src dir: %w", err)
	}

	gitDir := filepath.Join(absSrc, ".git")
	isGit := false
	if fi, err := os.Stat(gitDir); err == nil && (fi.IsDir() || !fi.IsDir()) { // git submodules or worktrees have .git as file
		isGit = true
	}

	if !isGit {
		// Non-git directory: copy directory contents recursively
		if err := copyDir(absSrc, targetDir); err != nil {
			return nil, fmt.Errorf("copy non-git dir: %w", err)
		}
		return &Checkout{
			Dir:    targetDir,
			Commit: "local",
		}, nil
	}

	// Git repository: use shared clone
	if err := os.MkdirAll(filepath.Dir(targetDir), 0o755); err != nil {
		return nil, fmt.Errorf("create target parent dir: %w", err)
	}

	cloneCmd := execx.Cmd{
		Name: "git",
		Args: []string{"clone", "--shared", absSrc, targetDir},
	}
	if err := s.Runner.Run(ctx, cloneCmd); err != nil {
		return nil, fmt.Errorf("git clone --shared: %w", err)
	}

	if s.Ref != "" {
		checkoutCmd := execx.Cmd{
			Name: "git",
			Args: []string{"-C", targetDir, "checkout", s.Ref},
		}
		if err := s.Runner.Run(ctx, checkoutCmd); err != nil {
			return nil, fmt.Errorf("git checkout %s: %w", s.Ref, err)
		}
	}

	var stdout bytes.Buffer
	revCmd := execx.Cmd{
		Name:   "git",
		Args:   []string{"-C", targetDir, "rev-parse", "HEAD"},
		Stdout: &stdout,
	}
	if err := s.Runner.Run(ctx, revCmd); err != nil {
		return nil, fmt.Errorf("git rev-parse HEAD: %w", err)
	}
	commit := strings.TrimSpace(stdout.String())

	// If SyncWorktree is enabled, copy dirty/uncommitted modifications into targetDir
	if s.SyncWorktree {
		if err := s.syncDirty(ctx, absSrc, targetDir); err != nil {
			return nil, fmt.Errorf("sync dirty worktree: %w", err)
		}
	}

	return &Checkout{
		Dir:    targetDir,
		Commit: commit,
	}, nil
}

func (s *LocalSource) syncDirty(ctx context.Context, srcDir, targetDir string) error {
	var stdout bytes.Buffer
	diffCmd := execx.Cmd{
		Name:   "git",
		Args:   []string{"-C", srcDir, "diff", "HEAD"},
		Stdout: &stdout,
	}
	if err := s.Runner.Run(ctx, diffCmd); err == nil && stdout.Len() > 0 {
		applyCmd := execx.Cmd{
			Name:  "git",
			Args:  []string{"-C", targetDir, "apply", "--whitespace=nowarn"},
			Stdin: &stdout,
		}
		_ = s.Runner.Run(ctx, applyCmd)
	}
	return nil
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		return copyFile(path, target, info.Mode())
	})
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}
