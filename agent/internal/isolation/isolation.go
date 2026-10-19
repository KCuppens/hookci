// Package isolation runs one job process inside a sandbox. Two backends ship
// in M0: systemd (a transient service with the §6 sandbox properties and
// cgroup limits) and none (a plain process group for local development).
package isolation

import (
	"context"
	"errors"
	"io"
	"time"
)

// DefaultUser is the unprivileged runner account jobs run as under systemd.
const DefaultUser = "zeroci-run"

// UnitPrefix starts every job unit name; recovery lists units by it.
const UnitPrefix = "zeroci-run-"

// Limits are the resolved resource limits for one job. Zero means "unset" and
// the corresponding systemd property is omitted.
type Limits struct {
	CPUs        float64       // 2 -> CPUQuota=200%
	MemoryBytes int64         // MemoryMax=<bytes>
	Tasks       int           // TasksMax=<n>
	Timeout     time.Duration // RuntimeMaxSec=<seconds, rounded up>
	IOReadBps   int64         // IOReadBandwidthMax=<rundir> <bytes>
	IOWriteBps  int64         // IOWriteBandwidthMax=<rundir> <bytes>
}

// Spec describes one process to run in isolation.
type Spec struct {
	RunID          string
	Job            string   // job name, or "setup" for the setup phase
	Argv           []string // e.g. ["/bin/sh", "-ec", "npm ci"]
	Dir            string   // working directory (inside the run dir)
	Env            []string // full, already-clean environment (KEY=VALUE); backends add nothing
	Limits         Limits
	NetNSPath      string   // netns.Network.NSPath ("/run/netns/zc-<run>") when a netns exists, else ""
	ReadWritePaths []string // usually exactly [<rundir>]
	// Hide is a dir the unit sees as an empty read-only tmpfs, with only the
	// ReadWritePaths under it bound back in. The executor hides <state>/runs
	// so a job cannot reach other runs' dirs. Empty hides nothing.
	Hide   string
	User   string // default "zeroci-run"; empty means default
	Stdout io.Writer
	Stderr io.Writer
}

// Result is the outcome of one isolated process. It carries no stderr text:
// job output only reaches Spec.Stdout and Spec.Stderr.
type Result struct {
	ExitCode  int
	Duration  time.Duration
	TimedOut  bool // RuntimeMaxSec or ctx deadline hit
	Cancelled bool // ctx cancelled (not deadline)
}

// Unit is one live job unit.
type Unit struct {
	Name   string // zeroci-run-<run>-<job>.service without the suffix
	Active string // systemctl ACTIVE column
}

// Isolation runs job processes and finds or stops the ones still alive.
type Isolation interface {
	Name() string // "systemd" | "none"
	Run(ctx context.Context, spec Spec) (Result, error)
	Stop(ctx context.Context, unit string) error
	ListUnits(ctx context.Context, prefix string) ([]Unit, error)
}

var (
	ErrUnsupported = errors.New("isolation: backend unsupported on this host")
	ErrHubNone     = errors.New("isolation: none is never allowed when connected to a hub")
)

// UnitName returns "zeroci-run-<run>-<job>" with both parts sanitized.
func UnitName(runID, job string) string {
	return UnitPrefix + SanitizeUnitPart(runID) + "-" + SanitizeUnitPart(job)
}

// SanitizeUnitPart maps every byte outside [a-zA-Z0-9:_.-] to '_'.
func SanitizeUnitPart(s string) string {
	b := []byte(s)
	for i, c := range b {
		switch {
		case 'a' <= c && c <= 'z', 'A' <= c && c <= 'Z', '0' <= c && c <= '9',
			c == ':', c == '_', c == '.', c == '-':
		default:
			b[i] = '_'
		}
	}
	return string(b)
}
