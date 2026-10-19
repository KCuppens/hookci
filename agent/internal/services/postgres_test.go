package services

import (
	"context"
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
