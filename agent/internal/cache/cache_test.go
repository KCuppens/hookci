package cache

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

func TestCanWrite(t *testing.T) {
	tests := []struct {
		domain    TrustDomain
		protected bool
		want      bool
	}{
		{TrustDomainLocal, false, true},
		{TrustDomainLocal, true, true},
		{TrustDomainTrusted, true, true},
		{TrustDomainTrusted, false, false},
		{TrustDomainUntrusted, true, false},
		{TrustDomainUntrusted, false, false},
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
	err := mgr.Save(ctx, TrustDomainTrusted, true, "test-key", srcDir)
	if err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// 2. Restore cache in targetDir
	targetDir := filepath.Join(t.TempDir(), "target")
	restored, err := mgr.Restore(ctx, TrustDomainTrusted, "test-key", targetDir)
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
	restoredUntrusted, err := mgr.Restore(ctx, TrustDomainUntrusted, "test-key", untrustedTarget)
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
	err = mgr.Save(ctx, TrustDomainUntrusted, true, "evil-key", untrustedSrc)
	if err != nil {
		t.Fatalf("Save untrusted failed: %v", err)
	}
	if _, err := os.Stat(mgr.KeyDir(TrustDomainUntrusted, "evil-key")); !os.IsNotExist(err) {
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

	err := mgr.Save(ctx, TrustDomainLocal, false, "cache-1", srcDir)
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

func TestKeyDirSanitization(t *testing.T) {
	baseDir := filepath.Join(string(filepath.Separator), "cache")
	mgr := NewManager(baseDir, nil)
	domainDir := filepath.Join(baseDir, string(TrustDomainUntrusted))
	hashed := regexp.MustCompile(`^[0-9a-f]{32}$`)

	t.Run("safe key kept as is", func(t *testing.T) {
		for _, key := range []string{"npm-abc123", "go/mod-v1", "v1..2"} {
			got := mgr.KeyDir(TrustDomainUntrusted, key)
			if want := filepath.Join(domainDir, key); got != want {
				t.Errorf("KeyDir(%q) = %q, want %q", key, got, want)
			}
		}
	})

	for _, key := range []string{"../../etc/cron.d", "/etc/x", ".", "", "a/../../b"} {
		t.Run("unsafe "+key, func(t *testing.T) {
			got := mgr.KeyDir(TrustDomainUntrusted, key)
			if filepath.Dir(got) != domainDir || !hashed.MatchString(filepath.Base(got)) {
				t.Fatalf("KeyDir(%q) = %q, want one hex name directly under %q", key, got, domainDir)
			}
		})
	}

	a := mgr.KeyDir(TrustDomainUntrusted, "/etc/x")
	b := mgr.KeyDir(TrustDomainUntrusted, "../../etc/cron.d")
	if a == b {
		t.Errorf("distinct unsafe keys collided: %q", a)
	}
}
