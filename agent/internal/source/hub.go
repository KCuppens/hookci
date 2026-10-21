package source

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/KCuppens/hookci/agent/internal/askpass"
	"github.com/KCuppens/hookci/agent/internal/execx"
)

// TokenFunc returns a GitHub fetch token for runID.
type TokenFunc func(ctx context.Context, runID string) (string, error)

// HubSource fetches a commit from GitHub with a hub-issued installation
// token. git gets the token only through GIT_ASKPASS: the askpass helper is
// the hookci binary itself, which reads the token from a 0600 unix socket
// that lives only for the fetch.
type HubSource struct {
	Git      string    // git binary; empty means "git"
	Tokens   TokenFunc // asked at most once per checkout, on git's first prompt
	WorkRoot string    // parent of the per-checkout scratch dirs; must exist
	// RemoteURL maps "owner/name" to the fetch URL; nil means
	// https://github.com/<repo>.git.
	RemoteURL func(repo string) string
}

// Name implements Source.
func (h *HubSource) Name() string { return "hub" }

// Checkout fetches req.Ref when it is a pull request ref, else req.SHA, at
// depth 1 into dir and verifies HEAD is req.SHA (ErrSHAMismatch otherwise).
// A non-empty req.BaseSHA is also fetched into a separate tree, Checkout.BaseDir,
// that Release removes.
func (h *HubSource) Checkout(ctx context.Context, req Request, dir string) (Checkout, error) {
	start := time.Now()
	if !shaRe.MatchString(req.SHA) {
		return Checkout{}, fmt.Errorf("%w: %q", ErrBadSHA, req.SHA)
	}
	if req.BaseSHA != "" && !shaRe.MatchString(req.BaseSHA) {
		return Checkout{}, fmt.Errorf("%w: base %q", ErrBadSHA, req.BaseSHA)
	}
	if err := requireEmptyDir(dir); err != nil {
		return Checkout{}, err
	}
	scratch, err := os.MkdirTemp(h.WorkRoot, "co-")
	if err != nil {
		return Checkout{}, fmt.Errorf("source: hub checkout scratch: %w", err)
	}
	var once sync.Once
	release := func() { once.Do(func() { _ = os.RemoveAll(scratch) }) }
	co, err := h.checkout(ctx, req, dir, scratch)
	if err != nil {
		release()
		return Checkout{}, err
	}
	co.Duration = time.Since(start)
	co.Release = release
	return co, nil
}

func (h *HubSource) checkout(ctx context.Context, req Request, dir, scratch string) (Checkout, error) {
	home := filepath.Join(scratch, "home")
	if err := os.Mkdir(home, 0o700); err != nil {
		return Checkout{}, fmt.Errorf("source: hub checkout home: %w", err)
	}
	self, err := os.Executable()
	if err != nil {
		return Checkout{}, fmt.Errorf("source: locate askpass helper: %w", err)
	}
	sock := filepath.Join(scratch, "a.sock")
	var (
		mu     sync.Mutex
		cached string
	)
	stop, err := askpass.Serve(ctx, sock, func(ctx context.Context) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		if cached == "" {
			tok, err := h.Tokens(ctx, req.RunID)
			if err != nil {
				return "", err
			}
			cached = tok
		}
		return cached, nil
	})
	if err != nil {
		return Checkout{}, err
	}
	defer stop()

	g := Git{Runner: execx.OS{}, Bin: h.Git}
	plain := SafeGitEnv(home)
	fetchEnv := SafeGitEnv(home, "GIT_ASKPASS="+self, askpass.EnvSock+"="+sock)
	url := h.remote(req.Repo)

	ref := req.SHA
	if strings.HasPrefix(req.Ref, "refs/pull/") {
		ref = req.Ref
	}
	if err := fetchTree(ctx, g, dir, url, ref, plain, fetchEnv); err != nil {
		return Checkout{}, err
	}
	out, err := g.Run(ctx, "", plain, nil, "-c", "safe.directory="+dir, "-C", dir, "rev-parse", "HEAD")
	if err != nil {
		return Checkout{}, err
	}
	if got := strings.TrimSpace(string(out)); got != req.SHA {
		return Checkout{}, fmt.Errorf("%w: %s resolved to %s, want %s", ErrSHAMismatch, ref, got, req.SHA)
	}

	var baseDir string
	if req.BaseSHA != "" {
		baseDir = filepath.Join(scratch, "base")
		if err := fetchTree(ctx, g, baseDir, url, req.BaseSHA, plain, fetchEnv); err != nil {
			return Checkout{}, fmt.Errorf("source: fetch base: %w", err)
		}
	}
	stop()

	if req.RunAs != nil {
		if err := chownTree(dir, req.RunAs, nil); err != nil {
			return Checkout{}, err
		}
	}
	return Checkout{Repo: req.Repo, Dir: dir, SHA: req.SHA, Ref: req.Ref, BaseDir: baseDir}, nil
}

func (h *HubSource) remote(repo string) string {
	if h.RemoteURL != nil {
		return h.RemoteURL(repo)
	}
	return "https://github.com/" + repo + ".git"
}

// fetchTree initialises dir, fetches ref at depth 1 and checks it out
// detached. Only the fetch sees fetchEnv, the askpass variables.
func fetchTree(ctx context.Context, g Git, dir, url, ref string, plain, fetchEnv []string) error {
	safe := "safe.directory=" + dir
	if _, err := g.Run(ctx, "", plain, nil, "init", "--quiet", dir); err != nil {
		return err
	}
	if _, err := g.Run(ctx, "", fetchEnv, nil, "-c", safe, "-C", dir, "fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "--quiet", url, ref); err != nil {
		return err
	}
	_, err := g.Run(ctx, "", plain, nil, "-c", safe, "-C", dir, "checkout", "--detach", "--quiet", "FETCH_HEAD")
	return err
}

// chownTree hands every file under dir to cred with chown (nil: os.Lchown).
func chownTree(dir string, cred *syscall.Credential, chown func(path string, uid, gid int) error) error {
	if chown == nil {
		chown = os.Lchown
	}
	err := filepath.WalkDir(dir, func(p string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		return chown(p, int(cred.Uid), int(cred.Gid))
	})
	if err != nil {
		return fmt.Errorf("source: hand checkout to job user: %w", err)
	}
	return nil
}
