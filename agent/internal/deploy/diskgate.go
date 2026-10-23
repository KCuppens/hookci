package deploy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/execx"
	"github.com/KCuppens/hookci/agent/internal/store"
)

// StatfsFunc returns the bytes available to unprivileged users on the file
// system holding path.
type StatfsFunc func(path string) (freeBytes uint64, err error)

// PreflightFunc checks the host before a run's first step. Its error text
// becomes the run error.
type PreflightFunc func(ctx context.Context, run store.DeployRun) error

// MinFreeBytes is gc.min_free_bytes of cfg, with the schema default when the
// gc section is absent.
func MinFreeBytes(cfg config.AgentConfig) int64 {
	g := cfg.Gc
	if g == nil {
		g = &config.AgentConfigGc{}
		_ = json.Unmarshal([]byte("{}"), g)
	}
	return int64(g.MinFreeBytes)
}

// DockerRootDir asks the docker daemon where it keeps images and volumes.
func DockerRootDir(ctx context.Context, r execx.Runner) (string, error) {
	var out bytes.Buffer
	if err := r.Run(ctx, execx.Cmd{Name: "docker", Args: []string{"info", "--format", "{{.DockerRootDir}}"}, Stdout: &out}); err != nil {
		return "", fmt.Errorf("deploy: docker info: %w", err)
	}
	dir := strings.TrimSpace(out.String())
	if dir == "" {
		return "", fmt.Errorf("deploy: docker info printed no DockerRootDir")
	}
	return dir, nil
}

// CheckDiskHeadroom returns an error naming the first of paths whose file
// system has less than min bytes free.
func CheckDiskHeadroom(paths []string, min int64, statfs StatfsFunc) error {
	for _, path := range paths {
		free, err := statfs(path)
		if err != nil {
			return fmt.Errorf("deploy: statfs %s: %w", path, err)
		}
		if min > 0 && free < uint64(min) {
			return fmt.Errorf("gc.min_free_bytes: free disk %d on %s below %d; run hookci gc or raise the limit", free, path, min)
		}
	}
	return nil
}

// DiskPreflight fails a run when the docker root dir or stateDir has less
// than min bytes free.
func DiskPreflight(r execx.Runner, stateDir string, min int64, statfs StatfsFunc) PreflightFunc {
	return func(ctx context.Context, _ store.DeployRun) error {
		root, err := DockerRootDir(ctx, r)
		if err != nil {
			return err
		}
		return CheckDiskHeadroom([]string{root, stateDir}, min, statfs)
	}
}
