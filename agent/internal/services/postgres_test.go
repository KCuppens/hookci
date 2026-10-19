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

	cfg := config.ServiceConfig{
		Image: "postgres:16-alpine",
		Env: config.ServiceConfigEnv{
			"POSTGRES_DB": "testdb",
		},
	}

	svc, err := mgr.Start(ctx, "01j7run", "postgres", cfg, socketDir)
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	if svc.ContainerName != "zeroci-service-01j7run-postgres" {
		t.Errorf("ContainerName = %q", svc.ContainerName)
	}
	if svc.Env["PGHOST"] != socketDir {
		t.Errorf("PGHOST = %q, want %q", svc.Env["PGHOST"], socketDir)
	}
	if svc.Env["PGDATABASE"] != "testdb" {
		t.Errorf("PGDATABASE = %q, want 'testdb'", svc.Env["PGDATABASE"])
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
		"-e POSTGRES_DB=testdb",
		"-e POSTGRES_HOST_AUTH_METHOD=trust",
		"postgres:16-alpine",
	}

	for _, token := range expectedTokens {
		if !strings.Contains(args, token) {
			t.Errorf("missing token %q in args: %s", token, args)
		}
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

	cfg := config.ServiceConfig{
		Image: "postgres:16-alpine",
	}

	svc, err := mgr.Start(ctx, "integtest", "postgres", cfg, socketDir)
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
