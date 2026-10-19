// Package netns gives a run a private network namespace whose only exit is
// the run's egress proxy. The agent creates /run/netns/zc-<run> with ip,
// brings up loopback and starts pasta in splice-only mode, which forwards
// 127.0.0.1:InNSProxyPort inside the namespace to the proxy's host port and
// gives the namespace no outbound route. Jobs join the namespace through
// isolation.Spec.NetNSPath and reach the proxy through ProxyEnv.
//
// Without pasta, ip or root, trusted runs fall back to the systemd
// IPAddressDeny set (ModeDeny) and untrusted runs refuse to start.
package netns

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/isolation"
)

// Mode is how a run's network is restricted.
type Mode string

const (
	ModeNetns Mode = "netns" // private namespace, egress only via proxy
	ModeDeny  Mode = "deny"  // no namespace, systemd IPAddressDeny set, no proxy
	ModeHost  Mode = "host"  // isolation none: host network, no restriction
)

// ErrNetnsRequired is returned by Decide for an untrusted run on a host
// that cannot create a private namespace.
var ErrNetnsRequired = errors.New("untrusted run requires a private network namespace, but pasta or ip is not available on this host")

const (
	nsPrefix     = "zc-"
	maxNSNameLen = 15

	defaultNetnsDir     = "/run/netns"
	defaultReadyTimeout = 5 * time.Second
	pastaGrace          = 2 * time.Second
)

// NSName returns "zc-" + isolation.SanitizeUnitPart(runID), lower-cased with
// every byte outside [a-z0-9-] mapped to '-', truncated to at most 15 bytes.
// Truncation keeps the tail: run IDs start with a millisecond timestamp and
// end in random characters, so the tail keeps concurrent runs apart.
func NSName(runID string) string {
	part := []byte(strings.ToLower(isolation.SanitizeUnitPart(runID)))
	for i, c := range part {
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
			part[i] = '-'
		}
	}
	if keep := maxNSNameLen - len(nsPrefix); len(part) > keep {
		part = part[len(part)-keep:]
	}
	return nsPrefix + string(part)
}

// Decide picks the mode. isolationName is the selected Isolation.Name().
// "none" -> ModeHost. available=false and trusted -> ModeDeny plus a
// warning. available=false and untrusted -> ErrNetnsRequired.
func Decide(isolationName string, trusted, available bool) (Mode, string, error) {
	switch {
	case isolationName == "none":
		return ModeHost, "", nil
	case available:
		return ModeNetns, "", nil
	case trusted:
		return ModeDeny, "pasta or ip is not available on this host: trusted run falls back to the systemd IPAddressDeny set with no egress proxy", nil
	default:
		return "", "", ErrNetnsRequired
	}
}

// Manager creates and removes per-run namespaces. The zero value uses the
// real ip, pasta and /run/netns.
type Manager struct {
	Runner       execx.Runner                                           // runs ip commands; default execx.OS{}
	Start        func(context.Context, execx.Cmd) (*execx.Group, error) // default execx.StartGroup, fake in tests
	LookPath     func(string) (string, error)                           // default exec.LookPath
	NetnsDir     string                                                 // default "/run/netns"
	ReadyTimeout time.Duration                                          // default 5s

	euid func() int // default os.Geteuid
}

// Available reports whether ip and pasta are on PATH and we are root.
// The reason string explains what is missing.
func (m *Manager) Available() (bool, string) {
	lookPath := m.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	euid := m.euid
	if euid == nil {
		euid = os.Geteuid
	}
	var missing []string
	for _, bin := range []string{"ip", "pasta"} {
		if _, err := lookPath(bin); err != nil {
			missing = append(missing, bin+" not found on PATH")
		}
	}
	if id := euid(); id != 0 {
		missing = append(missing, fmt.Sprintf("not running as root (euid %d)", id))
	}
	if len(missing) > 0 {
		return false, strings.Join(missing, "; ")
	}
	return true, ""
}

// Network is one run's network setup.
type Network struct {
	RunID         string
	Mode          Mode
	NSName        string // "" unless ModeNetns
	NSPath        string // "/run/netns/zc-<run>" or ""
	HostProxyPort int    // proxy port on the host side, 0 unless ModeNetns
	pasta         *execx.Group
}

// Setup creates the namespace and pasta for ModeNetns. For other modes it
// returns a Network with no side effects. pidFile is <rundir>/pasta.pid.
// On failure nothing is left behind.
func (m *Manager) Setup(ctx context.Context, runID string, mode Mode, hostProxyPort int, pidFile string) (*Network, error) {
	switch mode {
	case ModeDeny, ModeHost:
		return &Network{RunID: runID, Mode: mode}, nil
	case ModeNetns:
	default:
		return nil, fmt.Errorf("netns: unknown mode %q", mode)
	}

	name := NSName(runID)
	cleanupCtx := context.WithoutCancel(ctx)
	if err := m.ip(ctx, "netns", "add", name); err != nil {
		return nil, fmt.Errorf("netns: create %s: %w", name, err)
	}
	if err := m.ip(ctx, "-n", name, "link", "set", "lo", "up"); err != nil {
		return nil, errors.Join(fmt.Errorf("netns: bring up loopback in %s: %w", name, err), m.RemoveNamespace(cleanupCtx, name))
	}
	nsPath := filepath.Join(m.netnsDir(), name)
	pasta, err := m.startPasta(ctx, nsPath, hostProxyPort, pidFile)
	if err != nil {
		return nil, errors.Join(err, m.RemoveNamespace(cleanupCtx, name))
	}
	return &Network{
		RunID:         runID,
		Mode:          ModeNetns,
		NSName:        name,
		NSPath:        nsPath,
		HostProxyPort: hostProxyPort,
		pasta:         pasta,
	}, nil
}

// Env returns the proxy environment for jobs (nil unless ModeNetns).
func (n *Network) Env() []string {
	if n == nil || n.Mode != ModeNetns {
		return nil
	}
	return ProxyEnv(InNSProxyPort)
}

// Teardown stops pasta (SIGTERM, 2s grace, then SIGKILL) and deletes the
// namespace. Idempotent; errors for already-gone resources are ignored.
func (m *Manager) Teardown(ctx context.Context, n *Network) error {
	if n == nil || n.Mode != ModeNetns {
		return nil
	}
	var errs []error
	if n.pasta != nil {
		if err := n.pasta.Terminate(pastaGrace); err != nil {
			errs = append(errs, fmt.Errorf("netns: stop pasta for %s: %w", n.NSName, err))
		}
		n.pasta = nil
	}
	errs = append(errs, m.RemoveNamespace(ctx, n.NSName))
	return errors.Join(errs...)
}

// ListNamespaces returns names under NetnsDir with prefix "zc-" (used by
// crash recovery, M0-17). A missing NetnsDir yields an empty list.
func (m *Manager) ListNamespaces() ([]string, error) {
	dir := m.netnsDir()
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("netns: list %s: %w", dir, err)
	}
	names := []string{}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), nsPrefix) {
			names = append(names, e.Name())
		}
	}
	return names, nil
}

// RemoveNamespace runs "ip netns delete <name>" (used by M0-17). A namespace
// that is already gone is not an error.
func (m *Manager) RemoveNamespace(ctx context.Context, name string) error {
	err := m.ip(ctx, "netns", "delete", name)
	var exitErr *execx.ExitError
	if errors.As(err, &exitErr) && strings.Contains(exitErr.Stderr, "No such file") {
		return nil
	}
	if err != nil {
		return fmt.Errorf("netns: delete %s: %w", name, err)
	}
	return nil
}

func (m *Manager) ip(ctx context.Context, args ...string) error {
	runner := m.Runner
	if runner == nil {
		runner = execx.OS{}
	}
	return runner.Run(ctx, execx.Cmd{Name: "ip", Args: args})
}

func (m *Manager) netnsDir() string {
	if m.NetnsDir == "" {
		return defaultNetnsDir
	}
	return m.NetnsDir
}
