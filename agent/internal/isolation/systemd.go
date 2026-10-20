package isolation

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

// stopTimeout bounds the systemctl stop issued after the run's ctx is done.
const stopTimeout = 15 * time.Second

// ipDenyHost is the §6 deny list for units that share the host network.
// systemd 255's systemd-run rejects a symbolic name (localhost) mixed with
// prefixes in one value, so each entry is passed as its own property.
var ipDenyHost = []string{"localhost", "link-local", "multicast", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"}

// Systemd runs each job as a transient systemd service (not a scope) with the
// §6 sandbox properties and cgroup limits.
type Systemd struct {
	Runner     execx.Runner
	SystemdRun string // default "systemd-run"
	Systemctl  string // default "systemctl"
	Slice      string // default "zeroci.slice"
}

// Name reports "systemd".
func (s *Systemd) Name() string { return "systemd" }

func (s *Systemd) runner() execx.Runner {
	if s.Runner == nil {
		return execx.OS{}
	}
	return s.Runner
}

func (s *Systemd) systemdRun() string { return orDefault(s.SystemdRun, "systemd-run") }
func (s *Systemd) systemctl() string  { return orDefault(s.Systemctl, "systemctl") }
func (s *Systemd) slice() string      { return orDefault(s.Slice, "zeroci.slice") }

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// BuildSystemdRunArgv is pure and deterministic (properties in a fixed order).
// argv[0] is bin. --working-directory is omitted when spec.Dir is empty.
func BuildSystemdRunArgv(bin, slice string, spec Spec) []string {
	argv := []string{bin, "--wait", "--pipe", "--quiet",
		"--unit", UnitName(spec.RunID, spec.Job), "--slice", slice}
	if spec.Dir != "" {
		argv = append(argv, "--working-directory", spec.Dir)
	}
	prop := func(p string) { argv = append(argv, "-p", p) }

	prop("User=" + orDefault(spec.User, DefaultUser))
	prop("NoNewPrivileges=yes")
	prop("ProtectSystem=strict")
	prop("ProtectHome=yes")
	prop("PrivateTmp=yes")
	prop("PrivateDevices=yes")
	prop("ProtectProc=invisible")
	prop("ProcSubset=pid")
	if len(spec.ReadWritePaths) > 0 {
		prop("ReadWritePaths=" + strings.Join(spec.ReadWritePaths, " "))
	}
	if spec.Hide != "" {
		prop("TemporaryFileSystem=" + spec.Hide + ":ro")
		if len(spec.ReadWritePaths) > 0 {
			prop("BindPaths=" + strings.Join(spec.ReadWritePaths, " "))
		}
	}

	l := spec.Limits
	if l.CPUs > 0 {
		prop("CPUQuota=" + formatCPUQuota(l.CPUs))
	}
	if l.MemoryBytes > 0 {
		prop("MemoryMax=" + formatBytes(l.MemoryBytes))
	}
	if l.Tasks > 0 {
		prop("TasksMax=" + strconv.Itoa(l.Tasks))
	}
	if l.Timeout > 0 {
		prop("RuntimeMaxSec=" + ceilSeconds(l.Timeout))
	}
	if len(spec.ReadWritePaths) > 0 {
		dev := spec.ReadWritePaths[0]
		if l.IOReadBps > 0 {
			prop("IOReadBandwidthMax=" + dev + " " + formatBytes(l.IOReadBps))
		}
		if l.IOWriteBps > 0 {
			prop("IOWriteBandwidthMax=" + dev + " " + formatBytes(l.IOWriteBps))
		}
	}
	prop("Nice=10")

	if spec.NetNSPath == "" {
		for _, d := range ipDenyHost {
			prop("IPAddressDeny=" + d)
		}
	} else {
		prop("IPAddressDeny=any")
		prop("IPAddressAllow=localhost")
		prop("NetworkNamespacePath=" + spec.NetNSPath)
	}

	for _, kv := range spec.Env {
		argv = append(argv, "-E", kv)
	}
	argv = append(argv, "--")
	return append(argv, spec.Argv...)
}

// formatCPUQuota renders a CPU count as a systemd percentage: 2 -> "200%".
func formatCPUQuota(cpus float64) string {
	return strconv.FormatInt(int64(math.Round(cpus*100)), 10) + "%"
}

// formatBytes renders a byte count the way systemd accepts it: plain bytes.
func formatBytes(n int64) string {
	return strconv.FormatInt(n, 10)
}

// ceilSeconds renders d as whole seconds, rounded up: 90.5s -> "91".
func ceilSeconds(d time.Duration) string {
	return strconv.FormatInt(int64((d+time.Second-1)/time.Second), 10)
}

// Run executes spec as a transient service through systemd-run --wait and
// returns the unit's exit status. The job's output only reaches spec.Stdout
// and spec.Stderr; no stderr text is kept for error messages.
func (s *Systemd) Run(ctx context.Context, spec Spec) (Result, error) {
	if len(spec.Argv) == 0 {
		return Result{ExitCode: -1}, errors.New("isolation systemd: empty argv")
	}
	unit := UnitName(spec.RunID, spec.Job)
	argv := BuildSystemdRunArgv(s.systemdRun(), s.slice(), spec)
	cmd := execx.Cmd{Name: argv[0], Args: argv[1:], Stdout: spec.Stdout, Stderr: spec.Stderr}

	start := time.Now()
	done := make(chan error, 1)
	go func() { done <- s.runner().Run(ctx, cmd) }()

	var err error
	finished := false
	select {
	case err = <-done:
		finished = true
	case <-ctx.Done():
	}
	if ctx.Err() != nil {
		// Killing systemd-run does not stop the unit, so stop it explicitly.
		stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), stopTimeout)
		stopErr := s.Stop(stopCtx, unit)
		cancel()
		if !finished {
			<-done
		}
		res := Result{ExitCode: -1, Duration: time.Since(start)}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			res.TimedOut = true
		} else {
			res.Cancelled = true
		}
		if stopErr != nil {
			return res, fmt.Errorf("isolation systemd: stop %s after cancel: %w", unit, stopErr)
		}
		return res, nil
	}

	res := Result{Duration: time.Since(start)}
	var exitErr *execx.ExitError
	switch {
	case err == nil:
		return res, nil
	case errors.As(err, &exitErr):
		// Only the exit code is kept: ExitError.Stderr holds raw job output
		// that never went through redaction.
		res.ExitCode = exitErr.Code
	default:
		res.ExitCode = -1
		return res, fmt.Errorf("isolation systemd: run %s: %w", unit, err)
	}
	if s.unitResult(ctx, unit) == "timeout" {
		res.TimedOut = true
	}
	// Without --collect a failed unit stays loaded so its Result can be read
	// above; reset-failed then unloads it.
	s.resetFailed(ctx, unit)
	return res, nil
}

// unitResult reads the unit's Result property. It is best effort and returns
// "" when systemctl fails.
func (s *Systemd) unitResult(ctx context.Context, unit string) string {
	var out bytes.Buffer
	err := s.runner().Run(ctx, execx.Cmd{
		Name:   s.systemctl(),
		Args:   []string{"show", "-p", "Result", "--value", unit + ".service"},
		Stdout: &out,
	})
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out.String())
}

// resetFailed unloads a failed unit. It is best effort and survives a
// cancelled ctx: a unit left failed only lingers in systemctl list-units.
func (s *Systemd) resetFailed(ctx context.Context, unit string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), stopTimeout)
	defer cancel()
	_ = s.runner().Run(ctx, execx.Cmd{Name: s.systemctl(), Args: []string{"reset-failed", unit + ".service"}})
}

// Stop runs systemctl stop on the unit, then reset-failed so a unit that
// failed is unloaded too. A unit that is not loaded (exit 5) is already gone
// and is not an error.
func (s *Systemd) Stop(ctx context.Context, unit string) error {
	err := s.runner().Run(ctx, execx.Cmd{Name: s.systemctl(), Args: []string{"stop", unit + ".service"}})
	var exitErr *execx.ExitError
	if errors.As(err, &exitErr) && exitErr.Code == 5 {
		return nil
	}
	if err != nil {
		return fmt.Errorf("isolation systemd: stop %s: %w", unit, err)
	}
	s.resetFailed(ctx, unit)
	return nil
}

// ListUnits returns every loaded unit whose name starts with prefix.
func (s *Systemd) ListUnits(ctx context.Context, prefix string) ([]Unit, error) {
	var out bytes.Buffer
	err := s.runner().Run(ctx, execx.Cmd{
		Name:   s.systemctl(),
		Args:   []string{"list-units", "--plain", "--no-legend", "--all", prefix + "*"},
		Stdout: &out,
	})
	if err != nil {
		return nil, fmt.Errorf("isolation systemd: list units %s*: %w", prefix, err)
	}
	return parseListUnits(out.String()), nil
}

// parseListUnits reads `systemctl list-units --plain --no-legend` output:
// UNIT LOAD ACTIVE SUB DESCRIPTION.
func parseListUnits(out string) []Unit {
	var units []Unit
	for line := range strings.Lines(out) {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		units = append(units, Unit{Name: strings.TrimSuffix(f[0], ".service"), Active: f[2]})
	}
	return units
}
