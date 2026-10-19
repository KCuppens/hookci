package services

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

func TestStartPostgres(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"run"}, execx.FakeResponse{Code: 0})

	mgr := NewManager(fake)
	ctx := context.Background()
	socketDir := t.TempDir()

	svc, err := mgr.Start(ctx, "01j7run", config.ChecksServicesPostgres{Image: "postgres:15-alpine", Tmpfs: true}, socketDir)
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	if svc.ContainerName != "zeroci-service-01j7run-postgres" {
		t.Errorf("ContainerName = %q", svc.ContainerName)
	}
	if svc.Env["PGHOST"] != socketDir {
		t.Errorf("PGHOST = %q, want %q", svc.Env["PGHOST"], socketDir)
	}

	if len(fake.Calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(fake.Calls))
	}
	call := fake.Calls[0]
	if call.Name != "docker" {
		t.Errorf("call.Name = %q, want 'docker'", call.Name)
	}
	args := strings.Join(call.Args, " ")

	expectedTokens := []string{
		"run -d --rm",
		"--name zeroci-service-01j7run-postgres",
		"--network none",
		"--tmpfs /var/lib/postgresql/data",
		"-v " + socketDir + ":/var/run/postgresql",
		"-e POSTGRES_HOST_AUTH_METHOD=trust",
		"postgres:15-alpine",
	}

	for _, token := range expectedTokens {
		if !strings.Contains(args, token) {
			t.Errorf("missing token %q in args: %s", token, args)
		}
	}
}

func TestStartPostgresWithoutTmpfs(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"run"}, execx.FakeResponse{Code: 0})

	if _, err := NewManager(fake).Start(context.Background(), "01j7run", config.ChecksServicesPostgres{}, t.TempDir()); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	args := strings.Join(fake.Calls[0].Args, " ")
	if strings.Contains(args, "--tmpfs") {
		t.Errorf("tmpfs false still mounts tmpfs: %s", args)
	}
	if !strings.HasSuffix(args, " postgres:16-alpine") {
		t.Errorf("empty image does not fall back to postgres:16-alpine: %s", args)
	}
}

func TestStopPostgres(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"rm", "-f"}, execx.FakeResponse{Code: 0})

	mgr := NewManager(fake)
	ctx := context.Background()

	if err := mgr.Stop(ctx, "01j7run", "postgres"); err != nil {
		t.Fatalf("Stop failed: %v", err)
	}

	if len(fake.Calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(fake.Calls))
	}
	args := strings.Join(fake.Calls[0].Args, " ")
	if args != "rm -f zeroci-service-01j7run-postgres" {
		t.Errorf("unexpected args: %s", args)
	}
}

func TestCleanupServices(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"ps", "-aq"}, execx.FakeResponse{
		Stdout: "c1\nc2\n",
		Code:   0,
	})
	fake.On("docker", []string{"rm", "-f"}, execx.FakeResponse{Code: 0})

	mgr := NewManager(fake)
	ctx := context.Background()

	if err := mgr.Cleanup(ctx, "01j7run"); err != nil {
		t.Fatalf("Cleanup failed: %v", err)
	}

	if len(fake.Calls) != 2 {
		t.Fatalf("expected 2 calls, got %d", len(fake.Calls))
	}
	args := fake.Calls[0].Args
	if len(args) != 4 || strings.Join(args[:3], " ") != "ps -aq --filter" || !strings.HasPrefix(args[3], "name=") {
		t.Fatalf("unexpected ps args: %v", args)
	}
	prefix := strings.TrimPrefix(args[3], "name=")
	if !strings.HasPrefix(ContainerName("01j7run", "postgres"), prefix) {
		t.Errorf("filter %q does not match this run's container %q", prefix, ContainerName("01j7run", "postgres"))
	}
	if strings.HasPrefix(ContainerName("01j7run2", "postgres"), prefix) {
		t.Errorf("filter %q also matches run 01j7run2", prefix)
	}
	rmArgs := strings.Join(fake.Calls[1].Args, " ")
	if rmArgs != "rm -f c1 c2" {
		t.Errorf("unexpected rm args: %s", rmArgs)
	}
}

func TestCleanupServicesEmpty(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"ps", "-aq"}, execx.FakeResponse{
		Stdout: "",
		Code:   0,
	})

	mgr := NewManager(fake)
	ctx := context.Background()

	if err := mgr.Cleanup(ctx, "01j7run"); err != nil {
		t.Fatalf("Cleanup failed: %v", err)
	}

	if len(fake.Calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(fake.Calls))
	}
}

func TestCleanupServicesListFailure(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"ps"}, execx.FakeResponse{Code: 1, Stderr: "daemon down"})

	err := NewManager(fake).Cleanup(context.Background(), "01j7run")
	if err == nil || !strings.Contains(err.Error(), "01j7run") {
		t.Fatalf("expected list error naming run, got %v", err)
	}
	if fake.Called("docker", "rm") {
		t.Error("rm must not run after ps fails")
	}
}

func TestCleanupServicesRemoveFailure(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"ps"}, execx.FakeResponse{Stdout: "c1\n"})
	fake.On("docker", []string{"rm"}, execx.FakeResponse{Code: 1, Stderr: "in use"})

	err := NewManager(fake).Cleanup(context.Background(), "01j7run")
	var exitErr *execx.ExitError
	if !errors.As(err, &exitErr) || !strings.Contains(err.Error(), "remove docker services for run 01j7run") {
		t.Fatalf("expected wrapped rm exit error, got %v", err)
	}
}

func TestCleanupServicesNoDocker(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("docker", []string{"ps"}, execx.FakeResponse{Err: &exec.Error{Name: "docker", Err: exec.ErrNotFound}})

	if err := NewManager(fake).Cleanup(context.Background(), "01j7run"); err != nil {
		t.Fatalf("missing docker should mean nothing to clean, got %v", err)
	}
}

func TestPostgresIntegration(t *testing.T) {
	testutil.RequireIntegration(t)

	mgr := NewManager(nil)
	ctx := context.Background()
	socketDir := t.TempDir()

	svc, err := mgr.Start(ctx, "integtest", config.ChecksServicesPostgres{Image: "postgres:16-alpine", Tmpfs: true}, socketDir)
	if err != nil {
		t.Fatalf("Start integration failed: %v", err)
	}
	defer func() {
		_ = mgr.Stop(ctx, "integtest", "postgres")
	}()

	if svc.ContainerName != "zeroci-service-integtest-postgres" {
		t.Errorf("svc.ContainerName = %s", svc.ContainerName)
	}
}
