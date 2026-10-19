package isolation

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

func TestNoneBackend(t *testing.T) {
	ctx := context.Background()
	none := NewNone(nil)

	t.Run("successful execution", func(t *testing.T) {
		var stdout bytes.Buffer
		spec := Spec{
			RunID:   "run1",
			JobName: "test",
			Command: []string{"sh", "-c", "echo 'zeroci none'"},
			Stdout:  &stdout,
		}

		res, err := none.Run(ctx, spec)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res.ExitCode != 0 {
			t.Errorf("ExitCode = %d, want 0", res.ExitCode)
		}
		if strings.TrimSpace(stdout.String()) != "zeroci none" {
			t.Errorf("stdout = %q, want 'zeroci none'", stdout.String())
		}
	})

	t.Run("failing execution", func(t *testing.T) {
		spec := Spec{
			RunID:   "run1",
			JobName: "fail",
			Command: []string{"sh", "-c", "exit 42"},
		}

		res, err := none.Run(ctx, spec)
		if err != nil {
			t.Fatalf("Run returned unexpected err wrapper: %v", err)
		}
		if res.ExitCode != 42 {
			t.Errorf("ExitCode = %d, want 42", res.ExitCode)
		}
	})
}

func TestSystemdBackendArgs(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("systemd-run", nil, execx.FakeResponse{Code: 0})
	fake.On("systemctl", []string{"stop"}, execx.FakeResponse{Code: 0})
	fake.On("systemctl", []string{"reset-failed"}, execx.FakeResponse{Code: 0})
	systemd := NewSystemd(fake)

	spec := Spec{
		RunID:          "01j7abcxyz",
		JobName:        "lint",
		Command:        []string{"npm", "run", "lint"},
		Dir:            "/var/lib/zeroci/runs/01j7abcxyz/workdir",
		Env:            []string{"NODE_ENV=test", "CI=true"},
		User:           "zeroci-run",
		Slice:          "zeroci.slice",
		NetnsPath:      "/run/netns/zc-01j7abcxyz",
		CPUQuota:       "200%",
		MemoryMax:      "2G",
		TasksMax:       512,
		Timeout:        45 * time.Second,
		ReadWritePaths: []string{"/var/lib/zeroci/runs/01j7abcxyz"},
	}

	res, err := systemd.Run(context.Background(), spec)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.ExitCode != 0 {
		t.Errorf("ExitCode = %d, want 0", res.ExitCode)
	}

	if len(fake.Calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(fake.Calls))
	}

	call := fake.Calls[0]
	if call.Name != "systemd-run" {
		t.Errorf("call.Name = %q, want systemd-run", call.Name)
	}

	argsJoined := strings.Join(call.Args, " ")
	expectedFlags := []string{
		"--wait",
		"--pipe",
		"--collect",
		"--unit=zeroci-run-01j7abcxyz-lint",
		"--slice=zeroci.slice",
		"NoNewPrivileges=yes",
		"ProtectSystem=strict",
		"ProtectHome=yes",
		"PrivateTmp=yes",
		"PrivateDevices=yes",
		"Nice=10",
		"User=zeroci-run",
		"NetworkNamespacePath=/run/netns/zc-01j7abcxyz",
		"CPUQuota=200%",
		"MemoryMax=2G",
		"TasksMax=512",
		"RuntimeMaxSec=45",
		"ReadWritePaths=/var/lib/zeroci/runs/01j7abcxyz",
		"--working-directory=/var/lib/zeroci/runs/01j7abcxyz/workdir",
		"--setenv=NODE_ENV=test",
		"--setenv=CI=true",
		"-- npm run lint",
	}

	for _, flag := range expectedFlags {
		if !strings.Contains(argsJoined, flag) {
			t.Errorf("command args missing expected flag: %q\nFull args: %s", flag, argsJoined)
		}
	}

	// Test Cleanup
	fake.Calls = nil
	if err := systemd.Cleanup(context.Background(), "01j7abcxyz"); err != nil {
		t.Fatalf("Cleanup failed: %v", err)
	}

	if len(fake.Calls) != 2 {
		t.Fatalf("expected 2 calls for cleanup, got %d", len(fake.Calls))
	}
	if fake.Calls[0].Name != "systemctl" || fake.Calls[0].Args[0] != "stop" || fake.Calls[0].Args[1] != "zeroci-run-01j7abcxyz-*" {
		t.Errorf("stop call mismatch: %v", fake.Calls[0])
	}
	if fake.Calls[1].Name != "systemctl" || fake.Calls[1].Args[0] != "reset-failed" || fake.Calls[1].Args[1] != "zeroci-run-01j7abcxyz-*" {
		t.Errorf("reset-failed call mismatch: %v", fake.Calls[1])
	}
}

func TestSystemdIntegration(t *testing.T) {
	testutil.RequireIntegration(t)

	systemd := NewSystemd(nil)
	var stdout bytes.Buffer
	spec := Spec{
		RunID:   "integtest",
		JobName: "echo",
		Command: []string{"echo", "systemd integration ok"},
		Stdout:  &stdout,
	}

	res, err := systemd.Run(context.Background(), spec)
	if err != nil {
		t.Fatalf("systemd.Run failed: %v", err)
	}
	if res.ExitCode != 0 {
		t.Errorf("exit code = %d, want 0", res.ExitCode)
	}
	if !strings.Contains(stdout.String(), "systemd integration ok") {
		t.Errorf("unexpected output: %q", stdout.String())
	}
}
