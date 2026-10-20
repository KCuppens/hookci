package isolation

import (
	"errors"
	"fmt"
	"os"
	"runtime"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

// errAutoNeedsSystemd is the auto-selection failure on Linux hosts that
// cannot run systemd isolation. It never falls back to none silently.
var errAutoNeedsSystemd = errors.New("isolation auto: systemd isolation needs root and systemd-run; for local development pass --isolation none")

// SelectEnv is the host facts Select decides on, injectable for tests.
type SelectEnv struct {
	GOOS         string
	EUID         int
	LookPath     func(string) (string, error)
	HubConnected bool
	Runner       execx.Runner
	Warn         func(string)
}

// HostSelectEnv fills SelectEnv from the running host. M0 has no hub
// connection; Warn prints to stderr until the caller replaces it.
func HostSelectEnv() SelectEnv {
	return SelectEnv{
		GOOS:     runtime.GOOS,
		EUID:     os.Geteuid(),
		LookPath: func(name string) (string, error) { return execx.LookPath(name) },
		Runner:   execx.OS{},
		Warn:     func(msg string) { fmt.Fprintln(os.Stderr, "zeroci: warning: "+msg) },
	}
}

// Select resolves "auto" | "systemd" | "none" into a backend plus warnings.
// Selection is explicit: auto never degrades from systemd to none on Linux.
func Select(name string, env SelectEnv) (Isolation, []string, error) {
	switch name {
	case "systemd":
		if err := systemdUsable(env); err != nil {
			return nil, nil, err
		}
		return &Systemd{Runner: env.Runner}, nil, nil
	case "none":
		if env.HubConnected {
			return nil, nil, ErrHubNone
		}
		return &None{Warn: env.Warn}, nil, nil
	case "auto":
		switch env.GOOS {
		case "linux":
			if systemdUsable(env) != nil {
				return nil, nil, errAutoNeedsSystemd
			}
			return &Systemd{Runner: env.Runner}, nil, nil
		case "windows":
			return nil, nil, fmt.Errorf("%w: windows is not supported", ErrUnsupported)
		default:
			if env.HubConnected {
				return nil, nil, fmt.Errorf("isolation auto: systemd isolation needs linux, this host is %s: %w", env.GOOS, ErrHubNone)
			}
			warn := fmt.Sprintf("isolation auto: systemd isolation needs linux, this host is %s; using none", env.GOOS)
			return &None{Warn: env.Warn}, []string{warn}, nil
		}
	default:
		return nil, nil, fmt.Errorf("isolation: unknown backend %q (want auto, systemd or none)", name)
	}
}

// systemdUsable explains why the systemd backend cannot run here, or
// returns nil.
func systemdUsable(env SelectEnv) error {
	if env.GOOS != "linux" {
		return fmt.Errorf("%w: systemd isolation needs linux, this host is %s", ErrUnsupported, env.GOOS)
	}
	if env.EUID != 0 {
		return fmt.Errorf("%w: systemd isolation needs root, running as euid %d", ErrUnsupported, env.EUID)
	}
	if env.LookPath == nil {
		return fmt.Errorf("%w: systemd-run not found", ErrUnsupported)
	}
	if _, err := env.LookPath("systemd-run"); err != nil {
		return fmt.Errorf("%w: systemd-run not found: %v", ErrUnsupported, err)
	}
	return nil
}
