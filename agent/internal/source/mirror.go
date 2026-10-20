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

// Mirrors keeps one full bare mirror per repo under Root, which only the
// agent can read. Fetches and GC are serialised per repo. A sha fetched by
// Fetch is kept by refs/zeroci/<sha> until its fetches are cloned and every
// clone of it is released, and GC waits while any clone of the repo is live,
// so neither can prune objects a run needs.
type Mirrors struct {
	Root  string // <state>/mirrors, mode 0700
	Git   Git
	Chown func(path string, uid, gid int) error // hands a clone to its job user; nil: os.Lchown

	mu     sync.Mutex
	repoMu map[string]*sync.Mutex
	pins   map[pinKey]*pin
}

// pinKey is one sha of one mirror, keyed by slug.
type pinKey struct{ slug, sha string }

// pin counts the fetches of a sha that wait for their clone and the live
// clones of it. ref is set once Fetch has written refs/zeroci/<sha>.
type pin struct {
	waiting, clones int
	ref             bool
}

// NewMirrors returns Mirrors rooted at root.
func NewMirrors(root string, g Git) *Mirrors {
	return &Mirrors{Root: root, Git: g, repoMu: map[string]*sync.Mutex{}, pins: map[pinKey]*pin{}}
}

// shaRef is the mirror ref that keeps a fetched sha's objects from GC.
func shaRef(sha string) string { return "refs/zeroci/" + sha }

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

	// Jobs never read a mirror: a job's checkout carries its own objects.
	// The chmod tightens a root that older agents made 0755.
	if err := os.MkdirAll(m.Root, 0o700); err != nil {
		return "", fmt.Errorf("source: create mirror root: %w", err)
	}
	if err := os.Chmod(m.Root, 0o700); err != nil {
		return "", fmt.Errorf("source: restrict mirror root: %w", err)
	}
	switch fi, err := os.Stat(path); {
	case err == nil && !fi.IsDir():
		return "", fmt.Errorf("source: mirror %s is not a directory", path)
	case errors.Is(err, os.ErrNotExist):
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
// repo. Each refspec is a 40-hex sha or "+refs/...:refs/zeroci/...". A sha
// is stored as refs/zeroci/<sha> and counts as waiting for one CloneShared,
// so GC cannot prune it in between. env carries extra variables (askpass) on
// top of SafeGitEnv. The mirror keeps full history: never shallow.
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
	slug := filepath.Base(path)
	defer m.lockRepo(slug)()

	args := []string{"-C", path, "fetch", "--no-tags", "--no-recurse-submodules", "--prune", "origin"}
	var shas []string
	for _, r := range refspecs {
		if shaRe.MatchString(r) {
			shas = append(shas, r)
			r = "+" + r + ":" + shaRef(r)
		}
		args = append(args, r)
	}
	if _, err := m.Git.Run(ctx, "", gitEnv(env...), nil, args...); err != nil {
		return err
	}
	m.mu.Lock()
	for _, sha := range shas {
		p := m.pinFor(pinKey{slug, sha})
		p.waiting++
		p.ref = true
	}
	m.mu.Unlock()
	return nil
}

// pinFor returns the pin of k, creating it. m.mu must be held.
func (m *Mirrors) pinFor(k pinKey) *pin {
	p, ok := m.pins[k]
	if !ok {
		p = &pin{}
		m.pins[k] = p
	}
	return p
}

// unpin ends one clone of k. The last user of a fetched sha deletes its
// ref under the repo lock, so a concurrent Fetch of the sha cannot lose it.
func (m *Mirrors) unpin(path string, k pinKey) {
	defer m.lockRepo(k.slug)()
	m.mu.Lock()
	p := m.pins[k]
	p.clones--
	drop := p.clones == 0 && p.waiting == 0
	if drop {
		delete(m.pins, k)
	}
	m.mu.Unlock()
	if drop && p.ref {
		// A ref left behind only keeps objects alive, so failure is ignored.
		_, _ = m.Git.Run(context.Background(), "", gitEnv(), nil, "-C", path, "update-ref", "-d", shaRef(k.sha))
	}
}

// CloneShared checks sha out into dir, which must not exist or be empty.
// With cred nil the clone borrows the mirror's objects (git clone --shared).
// With cred set the job user must not read the mirror, so the agent clones
// with copied objects (--no-hardlinks), checks out, and hands every file to
// cred. sha stays pinned in the mirror until release, which is idempotent.
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
	k := pinKey{filepath.Base(path), sha}

	// Count the clone under the repo lock so it cannot start while GC runs.
	unlock := m.lockRepo(k.slug)
	m.mu.Lock()
	p := m.pinFor(k)
	if p.waiting > 0 {
		p.waiting--
	}
	p.clones++
	m.mu.Unlock()
	unlock()

	var once sync.Once
	release := func() { once.Do(func() { m.unpin(path, k) }) }
	if err := m.clone(ctx, path, sha, dir, cred); err != nil {
		release()
		return nil, err
	}
	return release, nil
}

func (m *Mirrors) clone(ctx context.Context, path, sha, dir string, cred *syscall.Credential) error {
	env := gitEnv()
	if cred == nil {
		if _, err := m.Git.Run(ctx, "", env, nil, "clone", "--shared", "--no-checkout", path, dir); err != nil {
			return err
		}
		_, err := m.Git.Run(ctx, "", env, nil, "-C", dir, "checkout", "--detach", "--quiet", sha)
		return err
	}
	if _, err := m.Git.Run(ctx, "", env, nil, "clone", "--no-hardlinks", "--no-checkout", path, dir); err != nil {
		return err
	}
	// dir belongs to the job user, so git needs it marked safe.
	if _, err := m.Git.Run(ctx, "", env, nil, "-c", "safe.directory="+dir, "-C", dir, "checkout", "--detach", "--quiet", sha); err != nil {
		return err
	}
	return chownTree(dir, cred, m.Chown)
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
	busy := false
	for k, p := range m.pins {
		if k.slug == slug && p.clones > 0 {
			busy = true
			break
		}
	}
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
