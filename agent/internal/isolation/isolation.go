package isolation

import (
	"context"
	"io"
	"time"
)

// Spec specifies how an isolated process execution should be configured.
type Spec struct {
	RunID          string
	JobName        string
	Command        []string
	Dir            string
	Env            []string
	Stdin          io.Reader
	Stdout         io.Writer
	Stderr         io.Writer
	User           string
	Slice          string
	NetnsPath      string
	CPUQuota       string
	MemoryMax      string
	TasksMax       uint64
	Timeout        time.Duration
	ReadWritePaths []string
}

// Result contains the outcome of an isolated execution.
type Result struct {
	ExitCode int
	Error    error
}

// Isolation abstracts process execution environments (systemd units or unisolated host processes).
type Isolation interface {
	Run(ctx context.Context, spec Spec) (Result, error)
	Cleanup(ctx context.Context, runID string) error
}
