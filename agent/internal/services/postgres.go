package services

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

// Service represents a running background service container.
type Service struct {
	Name          string
	ContainerName string
	SocketDir     string
	Env           map[string]string
}

// Manager manages lifecycle for background service containers (e.g. postgres).
type Manager struct {
	Runner execx.Runner
}

// NewManager creates a services Manager.
func NewManager(runner execx.Runner) *Manager {
	if runner == nil {
		runner = execx.OS{}
	}
	return &Manager{Runner: runner}
}

// ContainerName derives the docker container name for a run service.
func ContainerName(runID, serviceName string) string {
	return fmt.Sprintf("zeroci-service-%s-%s", runID, serviceName)
}

// Start launches a service container with --network none, data on tmpfs,
// and unix socket bind-mounted into socketDir.
func (m *Manager) Start(ctx context.Context, runID, name string, cfg config.ServiceConfig, socketDir string) (*Service, error) {
	containerName := ContainerName(runID, name)

	if err := os.MkdirAll(socketDir, 0777); err != nil {
		return nil, fmt.Errorf("mkdir socket dir %s: %w", socketDir, err)
	}
	// Ensure loose permissions so container postgres user can write socket
	_ = os.Chmod(socketDir, 0777)

	args := []string{
		"run", "-d", "--rm",
		"--name", containerName,
		"--network", "none",
	}

	if name == "postgres" {
		args = append(args,
			"--tmpfs", "/var/lib/postgresql/data",
			"-v", fmt.Sprintf("%s:/var/run/postgresql", socketDir),
		)
	} else {
		// Generic service support
		args = append(args, "-v", fmt.Sprintf("%s:/tmp/run", socketDir))
	}

	// Environment variables
	envKeys := make([]string, 0, len(cfg.Env))
	for k := range cfg.Env {
		envKeys = append(envKeys, k)
	}
	sort.Strings(envKeys)

	hasAuthMethod := false
	for _, k := range envKeys {
		if k == "POSTGRES_HOST_AUTH_METHOD" {
			hasAuthMethod = true
		}
		args = append(args, "-e", fmt.Sprintf("%s=%s", k, cfg.Env[k]))
	}

	if name == "postgres" && !hasAuthMethod {
		args = append(args, "-e", "POSTGRES_HOST_AUTH_METHOD=trust")
	}

	image := cfg.Image
	if image == "" {
		image = "postgres:16-alpine"
	}
	args = append(args, image)

	cmd := execx.Cmd{
		Name: "docker",
		Args: args,
	}

	if err := m.Runner.Run(ctx, cmd); err != nil {
		return nil, fmt.Errorf("start docker service %s: %w", containerName, err)
	}

	// Environment variables provided to connecting jobs
	jobEnv := make(map[string]string)
	if name == "postgres" {
		jobEnv["PGHOST"] = socketDir
		jobEnv["PGPORT"] = "5432"
		jobEnv["PGUSER"] = "postgres"
		if user, ok := cfg.Env["POSTGRES_USER"]; ok {
			jobEnv["PGUSER"] = user
		}
		if db, ok := cfg.Env["POSTGRES_DB"]; ok {
			jobEnv["PGDATABASE"] = db
		}
	}

	return &Service{
		Name:          name,
		ContainerName: containerName,
		SocketDir:     socketDir,
		Env:           jobEnv,
	}, nil
}

// Stop terminates and removes the background service container.
func (m *Manager) Stop(ctx context.Context, runID, name string) error {
	containerName := ContainerName(runID, name)
	cmd := execx.Cmd{
		Name: "docker",
		Args: []string{"rm", "-f", containerName},
	}
	if err := m.Runner.Run(ctx, cmd); err != nil {
		return fmt.Errorf("stop docker service %s: %w", containerName, err)
	}
	return nil
}

// Cleanup terminates and removes any service containers associated with the runID.
// A host without docker has nothing to clean, so a missing docker binary is not an error.
func (m *Manager) Cleanup(ctx context.Context, runID string) error {
	var buf bytes.Buffer
	cmd := execx.Cmd{
		Name:   "docker",
		Args:   []string{"ps", "-aq", "--filter", "name=" + ContainerName(runID, "")},
		Stdout: &buf,
	}
	if err := m.Runner.Run(ctx, cmd); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil
		}
		return fmt.Errorf("list docker services for run %s: %w", runID, err)
	}
	ids := strings.Fields(buf.String())
	if len(ids) > 0 {
		rmCmd := execx.Cmd{
			Name: "docker",
			Args: append([]string{"rm", "-f"}, ids...),
		}
		if err := m.Runner.Run(ctx, rmCmd); err != nil {
			return fmt.Errorf("remove docker services for run %s: %w", runID, err)
		}
	}
	return nil
}
