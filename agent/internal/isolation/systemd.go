package isolation

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

const defaultSlice = "zeroci.slice"

// Systemd manages isolated process execution inside transient systemd scopes/units.
type Systemd struct {
	Runner execx.Runner
}

// NewSystemd constructs a Systemd isolation backend.
func NewSystemd(runner execx.Runner) *Systemd {
	if runner == nil {
		runner = execx.OS{}
	}
	return &Systemd{
		Runner: runner,
	}
}

// UnitName computes the transient systemd unit name for a given run and job.
func UnitName(runID, jobName string) string {
	return fmt.Sprintf("zeroci-run-%s-%s", runID, jobName)
}

// Run executes the command in a transient systemd unit with full cgroup and namespace isolation.
func (s *Systemd) Run(ctx context.Context, spec Spec) (Result, error) {
	if len(spec.Command) == 0 {
		return Result{ExitCode: -1}, fmt.Errorf("empty command")
	}

	unit := UnitName(spec.RunID, spec.JobName)
	slice := spec.Slice
	if slice == "" {
		slice = defaultSlice
	}

	args := []string{
		"--wait",
		"--pipe",
		"--collect",
		"--unit=" + unit,
		"--slice=" + slice,
		"-p", "NoNewPrivileges=yes",
		"-p", "ProtectSystem=strict",
		"-p", "ProtectHome=yes",
		"-p", "PrivateTmp=yes",
		"-p", "PrivateDevices=yes",
		"-p", "Nice=10",
	}

	if spec.User != "" {
		args = append(args, "-p", "User="+spec.User)
	}
	if spec.NetnsPath != "" {
		args = append(args, "-p", "NetworkNamespacePath="+spec.NetnsPath)
	}
	if spec.CPUQuota != "" {
		args = append(args, "-p", "CPUQuota="+spec.CPUQuota)
	}
	if spec.MemoryMax != "" {
		args = append(args, "-p", "MemoryMax="+spec.MemoryMax)
	}
	if spec.TasksMax > 0 {
		args = append(args, "-p", "TasksMax="+strconv.FormatUint(spec.TasksMax, 10))
	}
	if spec.Timeout > 0 {
		sec := int(spec.Timeout.Seconds())
		if sec < 1 {
			sec = 1
		}
		args = append(args, "-p", "RuntimeMaxSec="+strconv.Itoa(sec))
	}
	for _, rw := range spec.ReadWritePaths {
		args = append(args, "-p", "ReadWritePaths="+rw)
	}

	if spec.Dir != "" {
		args = append(args, "--working-directory="+spec.Dir)
	}

	for _, env := range spec.Env {
		args = append(args, "--setenv="+env)
	}

	args = append(args, "--")
	args = append(args, spec.Command...)

	cmd := execx.Cmd{
		Name:   "systemd-run",
		Args:   args,
		Stdin:  spec.Stdin,
		Stdout: spec.Stdout,
		Stderr: spec.Stderr,
	}

	err := s.Runner.Run(ctx, cmd)
	if err == nil {
		return Result{ExitCode: 0, Error: nil}, nil
	}

	var exitErr *execx.ExitError
	if errors.As(err, &exitErr) {
		return Result{ExitCode: exitErr.Code, Error: exitErr}, nil
	}

	return Result{ExitCode: -1, Error: err}, err
}

// Cleanup stops any remaining orphan transient units for the given runID.
func (s *Systemd) Cleanup(ctx context.Context, runID string) error {
	pattern := fmt.Sprintf("zeroci-run-%s-*", runID)

	stopCmd := execx.Cmd{
		Name: "systemctl",
		Args: []string{"stop", pattern},
	}
	_ = s.Runner.Run(ctx, stopCmd)

	resetCmd := execx.Cmd{
		Name: "systemctl",
		Args: []string{"reset-failed", pattern},
	}
	_ = s.Runner.Run(ctx, resetCmd)

	return nil
}
