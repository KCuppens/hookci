package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os/exec"
	"slices"
	"strings"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

// Docker drives the docker CLI through an execx.Runner.
type Docker struct {
	Runner execx.Runner // nil -> execx.OS{}
	Bin    string       // "" -> "docker"
}

// ListByLabel returns the ids of every container, running or not, that
// carries label (a key, or key=value).
func (d Docker) ListByLabel(ctx context.Context, label string) ([]string, error) {
	stdout, _, err := d.run(ctx, "ps", "-aq", "--filter", "label="+label)
	if err != nil {
		return nil, fmt.Errorf("services: list containers with label %s: %w", label, err)
	}
	return strings.Fields(stdout), nil
}

// RemoveByLabel force-removes every container that carries label. It runs
// no rm when nothing matches.
func (d Docker) RemoveByLabel(ctx context.Context, label string) error {
	ids, err := d.ListByLabel(ctx, label)
	if err != nil || len(ids) == 0 {
		return err
	}
	if _, _, err := d.run(ctx, append([]string{"rm", "-f"}, ids...)...); err != nil {
		return fmt.Errorf("services: remove containers with label %s: %w", label, err)
	}
	return nil
}

// RunIDs returns the distinct LabelRun values of every container, running or
// not, that carries the label.
func (d Docker) RunIDs(ctx context.Context) ([]string, error) {
	stdout, _, err := d.run(ctx, "ps", "-a", "--filter", "label="+LabelRun, "--format", `{{.Label "`+LabelRun+`"}}`)
	if err != nil {
		return nil, fmt.Errorf("services: list run ids of containers: %w", err)
	}
	var ids []string
	for _, id := range strings.Fields(stdout) {
		if !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

// run executes docker with args and returns its captured output. A docker
// binary that cannot be found is reported as ErrDockerMissing.
func (d Docker) run(ctx context.Context, args ...string) (stdout, stderr string, err error) {
	runner, bin := d.Runner, d.Bin
	if runner == nil {
		runner = execx.OS{}
	}
	if bin == "" {
		bin = "docker"
	}
	var out, errOut bytes.Buffer
	err = runner.Run(ctx, execx.Cmd{Name: bin, Args: args, Stdout: &out, Stderr: &errOut})
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
		err = fmt.Errorf("%w: %w", ErrDockerMissing, err)
	}
	return out.String(), errOut.String(), err
}
