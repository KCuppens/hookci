package source

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
)

var (
	shaRe = regexp.MustCompile(`^[0-9a-f]{40}$`)
	// refRefspecRe accepts "+refs/<src>:refs/zeroci/<dst>" with plain ref characters only.
	refRefspecRe = regexp.MustCompile(`^\+refs/[A-Za-z0-9._/-]+:refs/zeroci/[A-Za-z0-9._/-]+$`)
)

// Mirrors keeps one full bare mirror per repo under Root. Fetches and GC are
// serialised per repo; shared clones are counted so GC never prunes objects
// a running checkout borrows through alternates.
type Mirrors struct {
	Root string // <state>/mirrors
	Git  Git

	mu     sync.Mutex
	repoMu map[string]*sync.Mutex
	active map[string]int
}

// NewMirrors returns Mirrors rooted at root.
func NewMirrors(root string, g Git) *Mirrors {
	return &Mirrors{Root: root, Git: g, repoMu: map[string]*sync.Mutex{}, active: map[string]int{}}
}

// Path returns <root>/<slug>.git.
func (m *Mirrors) Path(repo string) (string, error) {
	slug, err := Slug(repo)
	if err != nil {
		return "", err
	}
	return filepath.Join(m.Root, slug+".git"), nil
}

// lockRepo locks the per-repo mutex and returns its unlock. Keys are slugs,
// so case variants of a repo share one lock.
func (m *Mirrors) lockRepo(slug string) func() {
	m.mu.Lock()
	mu, ok := m.repoMu[slug]
	if !ok {
		mu = &sync.Mutex{}
		m.repoMu[slug] = mu
	}
	m.mu.Unlock()
	mu.Lock()
	return mu.Unlock
}

// Ensure creates the bare mirror (git init --bare) if missing and sets
// remote.origin.url. It returns the mirror path.
func (m *Mirrors) Ensure(ctx context.Context, repo, remoteURL string) (string, error) {
	path, err := m.Path(repo)
	if err != nil {
		return "", err
	}
	defer m.lockRepo(filepath.Base(path))()

	switch fi, err := os.Stat(path); {
	case err == nil && !fi.IsDir():
		return "", fmt.Errorf("source: mirror %s is not a directory", path)
	case errors.Is(err, os.ErrNotExist):
		// The job user reads the mirror through --shared alternates, so the
		// root stays traversable like the object dirs git creates.
		if err := os.MkdirAll(m.Root, 0o755); err != nil {
			return "", fmt.Errorf("source: create mirror root: %w", err)
		}
		if _, err := m.Git.Run(ctx, "", gitEnv(), nil, "init", "--quiet", "--bare", path); err != nil {
			return "", err
		}
	case err != nil:
		return "", fmt.Errorf("source: stat mirror: %w", err)
	}
	if _, err := m.Git.Run(ctx, "", gitEnv(), nil, "-C", path, "config", "remote.origin.url", remoteURL); err != nil {
		return "", err
	}
	return path, nil
}

// Fetch fetches exactly the given refspecs into the mirror, serialised per
// repo. Each refspec is a 40-hex sha or "+refs/...:refs/zeroci/...". env
// carries extra variables (askpass) on top of SafeGitEnv. The mirror keeps
// full history: never shallow.
func (m *Mirrors) Fetch(ctx context.Context, repo string, refspecs []string, env []string) error {
	if len(refspecs) == 0 {
		return errors.New("source: fetch needs at least one refspec")
	}
	for _, r := range refspecs {
		if !shaRe.MatchString(r) && (!refRefspecRe.MatchString(r) || strings.Contains(r, "..")) {
			return fmt.Errorf("%w: refspec %q is neither a sha nor +refs/...:refs/zeroci/...", ErrBadSHA, r)
		}
	}
	path, err := m.Path(repo)
	if err != nil {
		return err
	}
	defer m.lockRepo(filepath.Base(path))()

	args := append([]string{"-C", path, "fetch", "--no-tags", "--no-recurse-submodules", "--prune", "origin"}, refspecs...)
	_, err = m.Git.Run(ctx, "", gitEnv(env...), nil, args...)
	return err
}

// CloneShared runs git clone --shared --no-checkout <mirror> <dir>, then
// git -C <dir> checkout --detach --quiet <sha>, both as cred when non-nil.
// A clone as cred marks the agent-owned mirror as a safe.directory, since git
// refuses repositories owned by another user.
// dir must not exist or be empty. The repo counts as active until release
// is called; release is idempotent.
func (m *Mirrors) CloneShared(ctx context.Context, repo, sha, dir string, cred *syscall.Credential) (func(), error) {
	if !shaRe.MatchString(sha) {
		return nil, fmt.Errorf("%w: %q", ErrBadSHA, sha)
	}
	path, err := m.Path(repo)
	if err != nil {
		return nil, err
	}
	if err := requireEmptyDir(dir); err != nil {
		return nil, err
	}
	slug := filepath.Base(path)

	// Count the clone under the repo lock so it cannot start while GC runs.
	unlock := m.lockRepo(slug)
	m.mu.Lock()
	m.active[slug]++
	m.mu.Unlock()
	unlock()

	var once sync.Once
	release := func() {
		once.Do(func() {
			m.mu.Lock()
			m.active[slug]--
			m.mu.Unlock()
		})
	}

	env := gitEnv()
	clone := []string{"clone", "--shared", "--no-checkout", path, dir}
	if cred != nil {
		clone = append([]string{"-c", "safe.directory=" + path}, clone...)
	}
	if _, err := m.Git.Run(ctx, "", env, cred, clone...); err != nil {
		release()
		return nil, err
	}
	if _, err := m.Git.Run(ctx, "", env, cred, "-C", dir, "checkout", "--detach", "--quiet", sha); err != nil {
		release()
		return nil, err
	}
	return release, nil
}

// GC runs git gc --prune=now --auto when no shared clone of repo is active,
// and returns ErrBusy otherwise.
func (m *Mirrors) GC(ctx context.Context, repo string) error {
	path, err := m.Path(repo)
	if err != nil {
		return err
	}
	slug := filepath.Base(path)
	defer m.lockRepo(slug)()

	m.mu.Lock()
	busy := m.active[slug] > 0
	m.mu.Unlock()
	if busy {
		return ErrBusy
	}
	_, err = m.Git.Run(ctx, "", gitEnv(), nil, "-C", path, "gc", "--prune=now", "--auto")
	return err
}

func gitEnv(extra ...string) []string {
	return SafeGitEnv(os.Getenv("HOME"), extra...)
}

func requireEmptyDir(dir string) error {
	f, err := os.Open(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("source: checkout dir: %w", err)
	}
	defer f.Close()
	if _, err := f.Readdirnames(1); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("source: checkout dir %s is not empty", dir)
		}
		return fmt.Errorf("source: checkout dir: %w", err)
	}
	return nil
}
