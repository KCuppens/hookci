package cache

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/egress"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

func TestCanWrite(t *testing.T) {
	tests := []struct {
		domain    egress.TrustDomain
		protected bool
		want      bool
	}{
		{egress.TrustDomainLocal, false, true},
		{egress.TrustDomainLocal, true, true},
		{egress.TrustDomainTrusted, true, true},
		{egress.TrustDomainTrusted, false, false},
		{egress.TrustDomainUntrusted, true, false},
		{egress.TrustDomainUntrusted, false, false},
	}

	for _, tt := range tests {
		got := CanWrite(tt.domain, tt.protected)
		if got != tt.want {
			t.Errorf("CanWrite(%s, %v) = %v, want %v", tt.domain, tt.protected, got, tt.want)
		}
	}
}

func TestSaveAndRestoreReal(t *testing.T) {
	baseDir := t.TempDir()
	mgr := NewManager(baseDir, nil)
	ctx := context.Background()

	// Create source files to cache
	srcDir := filepath.Join(t.TempDir(), "src")
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "hello.txt"), []byte("cached content"), 0644); err != nil {
		t.Fatal(err)
	}

	// 1. Save cache for trusted + protected
	err := mgr.Save(ctx, egress.TrustDomainTrusted, true, "test-key", srcDir)
	if err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// 2. Restore cache in targetDir
	targetDir := filepath.Join(t.TempDir(), "target")
	restored, err := mgr.Restore(ctx, egress.TrustDomainTrusted, "test-key", targetDir)
	if err != nil {
		t.Fatalf("Restore failed: %v", err)
	}
	if !restored {
		t.Fatalf("expected restored=true")
	}

	content, err := os.ReadFile(filepath.Join(targetDir, "hello.txt"))
	if err != nil {
		t.Fatalf("read restored file: %v", err)
	}
	if string(content) != "cached content" {
		t.Errorf("got %q, want 'cached content'", string(content))
	}

	// 3. Untrusted run restores from trusted cache
	untrustedTarget := filepath.Join(t.TempDir(), "untrusted-target")
	restoredUntrusted, err := mgr.Restore(ctx, egress.TrustDomainUntrusted, "test-key", untrustedTarget)
	if err != nil {
		t.Fatalf("Restore untrusted failed: %v", err)
	}
	if !restoredUntrusted {
		t.Fatalf("expected untrusted to restore from trusted cache")
	}

	// 4. Untrusted run cannot save cache
	untrustedSrc := filepath.Join(t.TempDir(), "untrusted-src")
	_ = os.MkdirAll(untrustedSrc, 0755)
	_ = os.WriteFile(filepath.Join(untrustedSrc, "evil.txt"), []byte("evil"), 0644)
	err = mgr.Save(ctx, egress.TrustDomainUntrusted, true, "evil-key", untrustedSrc)
	if err != nil {
		t.Fatalf("Save untrusted failed: %v", err)
	}
	if _, err := os.Stat(mgr.KeyDir(egress.TrustDomainUntrusted, "evil-key")); !os.IsNotExist(err) {
		t.Errorf("expected untrusted cache to not be written")
	}
}

func TestReflinkCmdExecution(t *testing.T) {
	baseDir := t.TempDir()
	fake := &execx.Fake{}
	fake.On("cp", []string{"--reflink=auto"}, execx.FakeResponse{Code: 0})

	mgr := NewManager(baseDir, fake)
	ctx := context.Background()

	srcDir := filepath.Join(t.TempDir(), "src")
	_ = os.MkdirAll(srcDir, 0755)
	_ = os.WriteFile(filepath.Join(srcDir, "data.bin"), []byte("data"), 0644)

	err := mgr.Save(ctx, egress.TrustDomainLocal, false, "cache-1", srcDir)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	if len(fake.Calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(fake.Calls))
	}
	call := fake.Calls[0]
	if call.Name != "cp" || !strings.Contains(strings.Join(call.Args, " "), "--reflink=auto") {
		t.Errorf("unexpected call: %v", call)
	}
}
