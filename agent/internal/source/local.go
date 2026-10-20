package source

import (
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/KCuppens/hookci/agent/internal/execx"
)

// Local is the source for `hookci run`: it checks out the committed HEAD of
// the git repository containing Dir through a mirror, never the dirty tree,
// so local runs match what the hub would run.
type Local struct {
	Git     Git
	Dir     string // the directory hookci was invoked in
	Mirrors *Mirrors
	Warn    io.Writer // receives "warning: working tree has uncommitted changes; hookci runs the committed HEAD <sha7>"
}

// Name implements Source.
func (l *Local) Name() string { return "local" }

// Checkout implements Source. It fetches the commit into the mirror of
// LocalStorageRepo("local/<basename of toplevel>") and clones it into dir.
// The returned Checkout holds the mirror until its Release is called.
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
		fmt.Fprintf(l.Warn, "warning: working tree has uncommitted changes; hookci runs the committed HEAD %s\n", sha[:7])
	}

	repo := LocalRepo(top)
	stored := LocalStorageRepo(repo)
	if _, err := l.Mirrors.Ensure(ctx, stored, top); err != nil {
		return Checkout{}, err
	}
	if err := l.Mirrors.Fetch(ctx, stored, []string{sha}, nil); err != nil {
		return Checkout{}, err
	}
	release, err := l.Mirrors.CloneShared(ctx, stored, sha, dir, req.RunAs)
	if err != nil {
		return Checkout{}, err
	}
	return Checkout{Dir: dir, Repo: repo, SHA: sha, Ref: req.Ref, Dirty: dirty, Duration: time.Since(start), Release: release}, nil
}

// LocalRepo returns the "local/<name>" repo for a checkout directory. The
// directory name is mapped onto the slug alphabet, so the repo always forms a
// valid mirror path and cache trust domain.
func LocalRepo(dir string) string {
	return "local/" + localName(filepath.Base(dir))
}

// localStorageOwner is the owner local repos are stored under on disk.
// GitHub owners are letters, digits and inner hyphens, so no GitHub repo,
// not even "local/<name>", shares a mirror or cache dir with a local repo.
const localStorageOwner = "_local"

// LocalStorageRepo returns the repo naming the mirror and cache dirs of the
// LocalRepo result repo: "local/<name>" becomes "_local/<name>". Run records
// and trust domains keep "local/<name>".
func LocalStorageRepo(repo string) string {
	return localStorageOwner + "/" + strings.TrimPrefix(repo, "local/")
}

// localName maps a directory name onto the slug alphabet.
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
