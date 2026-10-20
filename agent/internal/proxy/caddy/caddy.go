// Package caddy implements proxy.ProxyAdapter for Caddy through a route
// snippet file that the operator's Caddyfile imports inside its site block.
// zeroci owns only that snippet: it never edits the main Caddyfile and never
// uses the Caddy admin API.
package caddy

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/proxy"
)

const (
	reloadTimeout = 30 * time.Second
	// stderrHead bounds how much reload stderr goes into the error.
	stderrHead = 512
	routeMode  = 0o644
)

var defaultReloadArgv = []string{"caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"}

// fsys is the filesystem surface Apply uses, so tests can inject faults.
type fsys interface {
	ReadFile(name string) ([]byte, error)
	CreateTemp(dir, pattern string) (tempFile, error)
	Rename(oldpath, newpath string) error
	Remove(name string) error
	SyncDir(dir string) error
}

// tempFile is the part of *os.File Apply writes through.
type tempFile interface {
	Name() string
	Chmod(mode os.FileMode) error
	Write(p []byte) (int, error)
	Sync() error
	Close() error
}

// Adapter is the Caddy proxy.ProxyAdapter.
type Adapter struct {
	Runner     execx.Runner // M0 command runner (fake in tests)
	ReloadArgv []string     // parsed from route.reload, default ["caddy","reload","--config","/etc/caddy/Caddyfile","--adapter","caddyfile"]
	FS         fsys         // small interface: ReadFile, WriteTemp+Sync+Rename, for fault injection
}

var _ proxy.ProxyAdapter = (*Adapter)(nil)

// New returns an Adapter whose reload command is route.reload split into
// argv with shell-words rules; no shell is ever invoked. An empty reload
// selects the default caddy reload command.
func New(runner execx.Runner, reload string) (*Adapter, error) {
	argv := slices.Clone(defaultReloadArgv)
	if strings.TrimSpace(reload) != "" {
		var err error
		if argv, err = splitArgv(reload); err == nil && (len(argv) == 0 || argv[0] == "") {
			err = errors.New("empty command")
		}
		if err != nil {
			return nil, fmt.Errorf("caddy: route.reload %q: %w", reload, err)
		}
	}
	return &Adapter{Runner: runner, ReloadArgv: argv, FS: osFS{}}, nil
}

// Render returns the two-line route snippet for route.
func (a *Adapter) Render(route proxy.RouteSpec) ([]byte, error) {
	if route.Port < 1 || route.Port > 65535 {
		return nil, fmt.Errorf("deployments.%s.route: port %d is outside 1 to 65535", route.Env, route.Port)
	}
	if route.UpstreamHost == "" {
		return nil, fmt.Errorf("deployments.%s.route: upstream_host is empty; set route.upstream_host", route.Env)
	}
	if strings.ContainsFunc(route.UpstreamHost, func(r rune) bool { return r == '{' || isSpace(r) }) {
		return nil, fmt.Errorf("deployments.%s.route: upstream_host %q must not contain whitespace, newlines or '{'", route.Env, route.UpstreamHost)
	}
	return fmt.Appendf(nil, "# managed by zeroci: %s %s color=%s. Do not edit.\nreverse_proxy %s:%d\n",
		route.Repo, route.Env, route.Color, route.UpstreamHost, route.Port), nil
}

// Apply atomically replaces file with content: it writes a temp file in the
// same directory, fsyncs it, renames it over file and fsyncs the directory.
// It returns the previous contents, nil when file did not exist.
func (a *Adapter) Apply(_ context.Context, file string, content []byte) ([]byte, error) {
	prev, err := a.FS.ReadFile(file)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		prev = nil
	case err != nil:
		return nil, fmt.Errorf("caddy: read route %s: %w", file, err)
	case prev == nil:
		prev = []byte{} // an existing empty file is not a missing file
	}

	dir := filepath.Dir(file)
	tmp, err := a.FS.CreateTemp(dir, "."+filepath.Base(file)+".zeroci-tmp-*")
	if err != nil {
		return nil, fmt.Errorf("caddy: create temp route in %s: %w", dir, err)
	}
	if err := writeSynced(tmp, content); err != nil {
		_ = a.FS.Remove(tmp.Name())
		return nil, fmt.Errorf("caddy: write temp route %s: %w", tmp.Name(), err)
	}
	if err := a.FS.Rename(tmp.Name(), file); err != nil {
		_ = a.FS.Remove(tmp.Name())
		return nil, fmt.Errorf("caddy: rename route into %s: %w", file, err)
	}
	if err := a.FS.SyncDir(dir); err != nil {
		return nil, fmt.Errorf("caddy: sync route dir %s: %w", dir, err)
	}
	return prev, nil
}

// writeSynced writes content to f with mode 0644, fsyncs and closes it.
func writeSynced(f tempFile, content []byte) error {
	err := f.Chmod(routeMode)
	if err == nil {
		_, err = f.Write(content)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// Reload runs ReloadArgv with a 30s timeout.
func (a *Adapter) Reload(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, reloadTimeout)
	defer cancel()

	stderr := &headBuffer{limit: stderrHead}
	err := a.Runner.Run(ctx, execx.Cmd{Name: a.ReloadArgv[0], Args: a.ReloadArgv[1:], Stderr: stderr})
	if err == nil {
		return nil
	}
	cmd := strings.Join(a.ReloadArgv, " ")
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("caddy: reload %q did not finish within %s%s", cmd, reloadTimeout, stderr.suffix())
	}
	var exit *execx.ExitError
	if errors.As(err, &exit) {
		return fmt.Errorf("caddy: reload %q: exit status %d%s", cmd, exit.Code, stderr.suffix())
	}
	return fmt.Errorf("caddy: reload %q: %w", cmd, err)
}

// headBuffer keeps the first limit bytes written to it.
type headBuffer struct {
	limit int
	buf   []byte
}

func (h *headBuffer) Write(p []byte) (int, error) {
	if room := h.limit - len(h.buf); room > 0 {
		h.buf = append(h.buf, p[:min(room, len(p))]...)
	}
	return len(p), nil
}

// suffix renders the captured stderr as ": <stderr>", or "" when empty.
func (h *headBuffer) suffix() string {
	s := strings.TrimSpace(string(h.buf))
	if s == "" {
		return ""
	}
	return ": " + s
}

// splitArgv splits s into words with POSIX shell quoting rules: blanks
// separate words, single quotes are literal, double quotes allow \" \\ \$
// \` escapes, and a backslash outside quotes escapes the next character.
// Nothing is expanded.
func splitArgv(s string) ([]string, error) {
	var (
		argv   []string
		word   strings.Builder
		inWord bool
	)
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case isSpace(rune(c)):
			if inWord {
				argv = append(argv, word.String())
				word.Reset()
				inWord = false
			}
		case c == '\\':
			i++
			if i == len(s) {
				return nil, errors.New("trailing backslash")
			}
			if s[i] != '\n' {
				word.WriteByte(s[i])
				inWord = true
			}
		case c == '\'':
			end := strings.IndexByte(s[i+1:], '\'')
			if end < 0 {
				return nil, errors.New("unterminated single quote")
			}
			word.WriteString(s[i+1 : i+1+end])
			i += end + 1
			inWord = true
		case c == '"':
			i++
			for ; i < len(s) && s[i] != '"'; i++ {
				if s[i] == '\\' && i+1 < len(s) && strings.IndexByte("\\\"$`\n", s[i+1]) >= 0 {
					i++
					if s[i] == '\n' {
						continue
					}
				}
				word.WriteByte(s[i])
			}
			if i == len(s) {
				return nil, errors.New("unterminated double quote")
			}
			inWord = true
		default:
			word.WriteByte(c)
			inWord = true
		}
	}
	if inWord {
		argv = append(argv, word.String())
	}
	return argv, nil
}

func isSpace(r rune) bool {
	return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f'
}

// osFS is fsys on the real filesystem.
type osFS struct{}

func (osFS) ReadFile(name string) ([]byte, error) { return os.ReadFile(name) }

func (osFS) CreateTemp(dir, pattern string) (tempFile, error) { return os.CreateTemp(dir, pattern) }

func (osFS) Rename(oldpath, newpath string) error { return os.Rename(oldpath, newpath) }

func (osFS) Remove(name string) error { return os.Remove(name) }

func (osFS) SyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	err = d.Sync()
	if cerr := d.Close(); err == nil {
		err = cerr
	}
	return err
}
