package isolation

import (
	"context"
	"errors"
	"fmt"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

// None implements direct host process execution with no sandbox isolation.
// Suitable for local development, unprivileged environments, and macOS.
type None struct {
	Runner execx.Runner
}

// NewNone constructs a None isolation backend.
func NewNone(runner execx.Runner) *None {
	if runner == nil {
		runner = execx.OS{}
	}
	return &None{
		Runner: runner,
	}
}

// Run executes the command directly on the host using the configured Runner.
func (n *None) Run(ctx context.Context, spec Spec) (Result, error) {
	if len(spec.Command) == 0 {
		return Result{ExitCode: -1}, fmt.Errorf("empty command")
	}

	cmdCtx := ctx
	if spec.Timeout > 0 {
		var cancel context.CancelFunc
		cmdCtx, cancel = context.WithTimeout(ctx, spec.Timeout)
		defer cancel()
	}

	cmd := execx.Cmd{
		Name:   spec.Command[0],
		Args:   spec.Command[1:],
		Dir:    spec.Dir,
		Env:    spec.Env,
		Stdin:  spec.Stdin,
		Stdout: spec.Stdout,
		Stderr: spec.Stderr,
	}

	err := n.Runner.Run(cmdCtx, cmd)
	if err == nil {
		return Result{ExitCode: 0, Error: nil}, nil
	}

	var exitErr *execx.ExitError
	if errors.As(err, &exitErr) {
		return Result{ExitCode: exitErr.Code, Error: exitErr}, nil
	}

	return Result{ExitCode: -1, Error: err}, err
}

// Cleanup is a no-op for the unisolated backend.
func (n *None) Cleanup(_ context.Context, _ string) error {
	return nil
}
