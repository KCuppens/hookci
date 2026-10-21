// Package execx wraps external command execution behind an interface so
// callers can swap a real OS runner for a fake one in tests.
package execx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"syscall"
	"time"
)

// tailLimit bounds how many trailing bytes of stderr are retained for
// inclusion in an ExitError.
const tailLimit = 4096

// Cmd describes a single command invocation.
type Cmd struct {
	Name       string
	Args       []string
	Dir        string
	Env        []string
	Stdin      io.Reader
	Stdout     io.Writer
	Stderr     io.Writer
	Credential *Credential // nil runs as the agent's user
}

// Runner executes a Cmd.
type Runner interface {
	Run(ctx context.Context, c Cmd) error
}

// OS is a Runner backed by os/exec.
type OS struct{}

// LookPath resolves command names to paths; a package-level var so tests
// can stub it out.
var LookPath = exec.LookPath

// Run executes c using os/exec, always capturing a bounded tail of stderr
// for inclusion in any resulting *ExitError.
func (OS) Run(ctx context.Context, c Cmd) error {
	cmd := exec.CommandContext(ctx, c.Name, c.Args...)
	cmd.Dir = c.Dir
	if c.Env != nil {
		cmd.Env = c.Env
	}
	cmd.Stdin = c.Stdin
	cmd.Stdout = c.Stdout

	tail := newTailBuffer(tailLimit)
	if c.Stderr != nil {
		cmd.Stderr = io.MultiWriter(c.Stderr, tail)
	} else {
		cmd.Stderr = tail
	}

	setCredential(cmd, c.Credential)

	cmd.Cancel = func() error {
		return cmd.Process.Signal(syscall.SIGTERM)
	}
	cmd.WaitDelay = 10 * time.Second

	err := cmd.Run()
	if err == nil {
		return nil
	}

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return &ExitError{Code: exitErr.ExitCode(), Stderr: tail.String()}
	}
	return fmt.Errorf("execx: run %s: %w", c.Name, err)
}

// ExitError reports a non-zero exit status and the trailing stderr output
// captured at the time of failure.
type ExitError struct {
	Code   int
	Stderr string
}

func (e *ExitError) Error() string {
	return fmt.Sprintf("exit status %d: %s", e.Code, e.Stderr)
}

// tailBuffer keeps only the last limit bytes written to it.
type tailBuffer struct {
	limit int
	buf   bytes.Buffer
}

func newTailBuffer(limit int) *tailBuffer {
	return &tailBuffer{limit: limit}
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	n := len(p)
	t.buf.Write(p)
	if over := t.buf.Len() - t.limit; over > 0 {
		b := t.buf.Bytes()
		t.buf.Reset()
		t.buf.Write(b[over:])
	}
	return n, nil
}

func (t *tailBuffer) String() string {
	return t.buf.String()
}
