package source

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

// Local is the source for `zeroci run`: it checks out the committed HEAD of
// the git repository containing Dir through a mirror, never the dirty tree,
// so local runs match what the hub would run.
type Local struct {
	Git     Git
	Dir     string // the directory zeroci was invoked in
	Mirrors *Mirrors
	Warn    io.Writer // receives "warning: working tree has uncommitted changes; zeroci runs the committed HEAD <sha7>"
}

// Name implements Source.
func (l *Local) Name() string { return "local" }

// Checkout implements Source. It fetches the commit into the mirror for
// "local/<basename of toplevel>" and shared-clones it into dir.
func (l *Local) Checkout(ctx context.Context, req Request, dir string) (Checkout, error) {
	start := time.Now()
	env := gitEnv()

	out, err := l.Git.Run(ctx, l.Dir, env, nil, "rev-parse", "--show-toplevel")
	if err != nil {
		var exitErr *execx.ExitError
		if errors.As(err, &exitErr) {
			return Checkout{}, fmt.Errorf("%w: %s", ErrNotGitRepo, l.Dir)
		}
		return Checkout{}, err
	}
	top := strings.TrimSpace(string(out))

	out, err = l.Git.Run(ctx, top, env, nil, "rev-parse", "HEAD")
	if err != nil {
		return Checkout{}, err
	}
	head := strings.TrimSpace(string(out))
	sha := req.SHA
	if sha == "" {
		sha = head
	}
	if !shaRe.MatchString(sha) {
		return Checkout{}, fmt.Errorf("%w: %q", ErrBadSHA, sha)
	}

	out, err = l.Git.Run(ctx, top, env, nil, "status", "--porcelain")
	if err != nil {
		return Checkout{}, err
	}
	dirty := len(strings.TrimSpace(string(out))) > 0
	if dirty && l.Warn != nil {
		fmt.Fprintf(l.Warn, "warning: working tree has uncommitted changes; zeroci runs the committed HEAD %s\n", sha[:7])
	}

	repo := "local/" + localName(filepath.Base(top))
	if _, err := l.Mirrors.Ensure(ctx, repo, top); err != nil {
		return Checkout{}, err
	}
	if err := l.Mirrors.Fetch(ctx, repo, []string{sha}, nil); err != nil {
		return Checkout{}, err
	}
	release, err := l.Mirrors.CloneShared(ctx, repo, sha, dir, req.RunAs)
	if err != nil {
		return Checkout{}, err
	}
	// Local runs come from one-shot `zeroci run`; the checkout is complete
	// here and the Source interface has no teardown hook to hold it longer.
	release()

	return Checkout{Dir: dir, SHA: sha, Ref: req.Ref, Dirty: dirty, Duration: time.Since(start)}, nil
}

// localName maps a directory name onto the slug alphabet so any checkout
// directory yields a valid "local/<name>" repo.
func localName(base string) string {
	b := []byte(base)
	for i, c := range b {
		if !slugByte(c) {
			b[i] = '-'
		}
	}
	if name := string(b); name != "." && name != ".." && name != "" {
		return name
	}
	return "root"
}
