// Package systemd manages the zeroci-agent@ units the installer writes,
// through systemctl.
package systemd

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

// AgentUnit is the zeroci-agent@ instance that runs the agent of an
// installation.
func AgentUnit(installationID int64) string {
	return "zeroci-agent@" + strconv.FormatInt(installationID, 10) + ".service"
}

// AllAgentUnits matches every zeroci-agent@ instance.
const AllAgentUnits = "zeroci-agent@*.service"

// ServiceManager is the part of systemd that connect and doctor use.
type ServiceManager interface {
	// UnitExists reports whether systemd knows unit. A host without
	// systemctl has no units.
	UnitExists(ctx context.Context, unit string) (bool, error)
	// EnableNow enables unit and starts it.
	EnableNow(ctx context.Context, unit string) error
	// ActiveState is the unit's ActiveState: active, inactive, failed...
	ActiveState(ctx context.Context, unit string) (string, error)
	// TryRestart restarts the units matching unit that are running.
	TryRestart(ctx context.Context, unit string) error
}

// Systemctl is the ServiceManager of the host, run through Runner.
type Systemctl struct {
	Runner execx.Runner
}

// UnitExists runs `systemctl cat`, which fails for unknown units.
func (s Systemctl) UnitExists(ctx context.Context, unit string) (bool, error) {
	err := s.Runner.Run(ctx, execx.Cmd{Name: "systemctl", Args: []string{"cat", "--", unit}})
	var exit *execx.ExitError
	switch {
	case err == nil:
		return true, nil
	case errors.As(err, &exit), errors.Is(err, exec.ErrNotFound):
		return false, nil
	default:
		return false, fmt.Errorf("systemd: %w", err)
	}
}

// EnableNow runs `systemctl enable --now`.
func (s Systemctl) EnableNow(ctx context.Context, unit string) error {
	if err := s.Runner.Run(ctx, execx.Cmd{Name: "systemctl", Args: []string{"enable", "--now", "--", unit}}); err != nil {
		return fmt.Errorf("systemd: enable %s: %w", unit, err)
	}
	return nil
}

// ActiveState runs `systemctl show -p ActiveState --value`.
func (s Systemctl) ActiveState(ctx context.Context, unit string) (string, error) {
	var out bytes.Buffer
	if err := s.Runner.Run(ctx, execx.Cmd{Name: "systemctl", Args: []string{"show", "-p", "ActiveState", "--value", "--", unit}, Stdout: &out}); err != nil {
		return "", fmt.Errorf("systemd: state of %s: %w", unit, err)
	}
	return strings.TrimSpace(out.String()), nil
}

// TryRestart runs `systemctl try-restart`, which leaves stopped units alone.
func (s Systemctl) TryRestart(ctx context.Context, unit string) error {
	if err := s.Runner.Run(ctx, execx.Cmd{Name: "systemctl", Args: []string{"try-restart", "--", unit}}); err != nil {
		return fmt.Errorf("systemd: try-restart %s: %w", unit, err)
	}
	return nil
}
