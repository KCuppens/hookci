package netns

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/egress"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

func TestNetnsCreateWithTools(t *testing.T) {
	origLookPath := execx.LookPath
	defer func() { execx.LookPath = origLookPath }()
	execx.LookPath = func(file string) (string, error) {
		return "/usr/bin/" + file, nil
	}

	fake := &execx.Fake{}
	fake.On("ip", []string{"netns", "add"}, execx.FakeResponse{Code: 0})
	fake.On("ip", []string{"-n", "zc-01j7test", "link", "set", "lo", "up"}, execx.FakeResponse{Code: 0})
	fake.On("pasta", nil, execx.FakeResponse{Code: 0})

	mgr := NewManager(fake)
	ctx := context.Background()

	ns, err := mgr.Create(ctx, "01j7test", 41234, egress.TrustDomainUntrusted)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	if ns.Fallback {
		t.Errorf("expected Fallback=false, got true")
	}
	if ns.Path != "/run/netns/zc-01j7test" {
		t.Errorf("ns.Path = %q, want /run/netns/zc-01j7test", ns.Path)
	}
	if ns.ProxyPort != 3128 {
		t.Errorf("ns.ProxyPort = %d, want 3128", ns.ProxyPort)
	}

	// Verify command calls
	if len(fake.Calls) != 3 {
		t.Fatalf("expected 3 calls, got %d", len(fake.Calls))
	}

	if fake.Calls[0].Name != "ip" || strings.Join(fake.Calls[0].Args, " ") != "netns add zc-01j7test" {
		t.Errorf("call 0 mismatch: %v", fake.Calls[0])
	}
	if fake.Calls[1].Name != "ip" || strings.Join(fake.Calls[1].Args, " ") != "-n zc-01j7test link set lo up" {
		t.Errorf("call 1 mismatch: %v", fake.Calls[1])
	}
	if fake.Calls[2].Name != "pasta" {
		t.Errorf("call 2 name mismatch: %v", fake.Calls[2])
	}
	pastaArgs := strings.Join(fake.Calls[2].Args, " ")
	if !strings.Contains(pastaArgs, "-T 3128:127.0.0.1:41234") {
		t.Errorf("pasta args missing forwarding spec: %s", pastaArgs)
	}
}

func TestNetnsUntrustedMissingToolsRejects(t *testing.T) {
	origLookPath := execx.LookPath
	defer func() { execx.LookPath = origLookPath }()
	execx.LookPath = func(file string) (string, error) {
		if file == "pasta" {
			return "", exec.ErrNotFound
		}
		return "/usr/bin/" + file, nil
	}

	fake := &execx.Fake{}
	mgr := NewManager(fake)
	ctx := context.Background()

	_, err := mgr.Create(ctx, "01j7test", 41234, egress.TrustDomainUntrusted)
	if !errors.Is(err, ErrUntrustedRequiresNetns) {
		t.Errorf("expected ErrUntrustedRequiresNetns, got %v", err)
	}
}

func TestNetnsTrustedMissingToolsFallback(t *testing.T) {
	origLookPath := execx.LookPath
	defer func() { execx.LookPath = origLookPath }()
	execx.LookPath = func(file string) (string, error) {
		if file == "pasta" {
			return "", exec.ErrNotFound
		}
		return "/usr/bin/" + file, nil
	}

	fake := &execx.Fake{}
	mgr := NewManager(fake)
	ctx := context.Background()

	ns, err := mgr.Create(ctx, "01j7test", 41234, egress.TrustDomainTrusted)
	if err != nil {
		t.Fatalf("unexpected error for trusted fallback: %v", err)
	}

	if !ns.Fallback {
		t.Errorf("expected Fallback=true for missing tools")
	}
	if len(ns.IPAddressDeny) == 0 {
		t.Errorf("expected non-empty IPAddressDeny for fallback")
	}
}

func TestNetnsDestroy(t *testing.T) {
	fake := &execx.Fake{}
	fake.On("ip", []string{"netns", "del", "zc-01j7test"}, execx.FakeResponse{Code: 0})

	mgr := NewManager(fake)
	ctx := context.Background()

	if err := mgr.Destroy(ctx, "01j7test"); err != nil {
		t.Fatalf("Destroy failed: %v", err)
	}

	if len(fake.Calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(fake.Calls))
	}
	if fake.Calls[0].Name != "ip" || strings.Join(fake.Calls[0].Args, " ") != "netns del zc-01j7test" {
		t.Errorf("destroy call mismatch: %v", fake.Calls[0])
	}
}

func TestNetnsIntegration(t *testing.T) {
	testutil.RequireIntegration(t)

	mgr := NewManager(nil)
	ctx := context.Background()
	runID := "integtest"

	ns, err := mgr.Create(ctx, runID, 3128, egress.TrustDomainUntrusted)
	if err != nil {
		t.Fatalf("Create netns failed: %v", err)
	}
	defer func() {
		_ = mgr.Destroy(ctx, runID)
	}()

	if ns.Path != "/run/netns/zc-integtest" {
		t.Errorf("ns.Path = %s, want /run/netns/zc-integtest", ns.Path)
	}
}
