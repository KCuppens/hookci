package netns

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

var (
	// ErrUntrustedRequiresNetns indicates an untrusted run cannot execute without netns isolation.
	ErrUntrustedRequiresNetns = errors.New("untrusted runs refuse to run without network namespace isolation")
)

// DefaultIPAddressDeny contains the CIDR ranges denied via systemd IPAddressDeny
// when pasta is unavailable and fallback isolation is active.
var DefaultIPAddressDeny = []string{
	"127.0.0.0/8",
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"169.254.0.0/16",
	"100.64.0.0/10",
	"::1/128",
	"fc00::/7",
	"fe80::/10",
}

// Namespace describes a per-run network namespace or active fallback policy.
type Namespace struct {
	Name          string
	Path          string
	ProxyPort     int
	Fallback      bool
	IPAddressDeny []string
}

// Manager orchestrates netns creation with ip and pasta or fallback IPAddressDeny.
type Manager struct {
	Runner execx.Runner
}

// NewManager constructs a netns Manager.
func NewManager(runner execx.Runner) *Manager {
	if runner == nil {
		runner = execx.OS{}
	}
	return &Manager{Runner: runner}
}

// NetnsName computes the network namespace name for a run: zc-<runID>.
func NetnsName(runID string) string {
	return "zc-" + runID
}

// NetnsPath computes the network namespace filesystem path for a run.
func NetnsPath(runID string) string {
	return filepath.Join("/run/netns", NetnsName(runID))
}

// HasTools checks whether the host system provides the required binaries: ip and pasta.
func (m *Manager) HasTools() bool {
	if _, err := execx.LookPath("ip"); err != nil {
		return false
	}
	if _, err := execx.LookPath("pasta"); err != nil {
		return false
	}
	return true
}

// Create provisions a dedicated network namespace for runID with pasta forwarding,
// or activates fallback restrictions if tools are absent.
func (m *Manager) Create(ctx context.Context, runID string, proxyPort int, trusted bool) (*Namespace, error) {
	hasTools := m.HasTools()

	if !hasTools {
		// Untrusted runs refuse to run without netns
		if !trusted {
			return nil, ErrUntrustedRequiresNetns
		}

		// Fallback for trusted/local runs: no netns, IPAddressDeny set
		return &Namespace{
			Fallback:      true,
			IPAddressDeny: DefaultIPAddressDeny,
		}, nil
	}

	nsName := NetnsName(runID)
	nsPath := NetnsPath(runID)

	// 1. Create network namespace: ip netns add zc-<run>
	addCmd := execx.Cmd{
		Name: "ip",
		Args: []string{"netns", "add", nsName},
	}
	if err := m.Runner.Run(ctx, addCmd); err != nil {
		return nil, fmt.Errorf("ip netns add %s: %w", nsName, err)
	}

	// 2. Bring up loopback: ip -n zc-<run> link set lo up
	loCmd := execx.Cmd{
		Name: "ip",
		Args: []string{"-n", nsName, "link", "set", "lo", "up"},
	}
	if err := m.Runner.Run(ctx, loCmd); err != nil {
		_ = m.Destroy(ctx, runID)
		return nil, fmt.Errorf("bring up loopback in %s: %w", nsName, err)
	}

	// 3. Connect pasta forwarding port 3128 in netns to proxyPort on host loopback
	// pasta --config-net --netns /run/netns/zc-<run> -T 3128:127.0.0.1:<proxyPort>
	forwardSpec := fmt.Sprintf("3128:127.0.0.1:%d", proxyPort)
	if proxyPort == 3128 {
		forwardSpec = "3128"
	}

	pastaCmd := execx.Cmd{
		Name: "pasta",
		Args: []string{
			"--config-net",
			"--netns", nsPath,
			"-T", forwardSpec,
		},
	}
	if err := m.Runner.Run(ctx, pastaCmd); err != nil {
		_ = m.Destroy(ctx, runID)
		return nil, fmt.Errorf("attach pasta to %s: %w", nsName, err)
	}

	return &Namespace{
		Name:      nsName,
		Path:      nsPath,
		ProxyPort: 3128,
		Fallback:  false,
	}, nil
}

// Destroy cleans up the network namespace and any lingering pasta processes.
func (m *Manager) Destroy(ctx context.Context, runID string) error {
	nsName := NetnsName(runID)

	delCmd := execx.Cmd{
		Name: "ip",
		Args: []string{"netns", "del", nsName},
	}
	err := m.Runner.Run(ctx, delCmd)

	// Also ensure file in /run/netns is removed if still present
	_ = os.Remove(NetnsPath(runID))

	if err != nil {
		return fmt.Errorf("ip netns del %s: %w", nsName, err)
	}
	return nil
}
