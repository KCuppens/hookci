package cache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/KCuppens/zerocideploy/agent/internal/egress"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

// Manager manages copy-on-write caches for job steps.
type Manager struct {
	BaseDir string
	Runner  execx.Runner
}

// NewManager creates a cache Manager rooted at baseDir.
func NewManager(baseDir string, runner execx.Runner) *Manager {
	if runner == nil {
		runner = execx.OS{}
	}
	return &Manager{
		BaseDir: baseDir,
		Runner:  runner,
	}
}

// CanWrite determines if the given trust domain and ref are permitted to write to cache.
// Rule: only trusted runs pushing to protected refs and local runs write caches.
func CanWrite(domain egress.TrustDomain, isProtectedRef bool) bool {
	if domain == egress.TrustDomainLocal {
		return true
	}
	if domain == egress.TrustDomainTrusted && isProtectedRef {
		return true
	}
	return false
}

// KeyDir returns the filesystem directory storing the cache for the given trust domain and key.
func (m *Manager) KeyDir(domain egress.TrustDomain, key string) string {
	clean := filepath.Clean(key)
	if !filepath.IsLocal(key) || clean == "." {
		h := sha256.Sum256([]byte(key))
		clean = hex.EncodeToString(h[:16])
	}
	// Partition by domain to prevent untrusted pollution
	return filepath.Join(m.BaseDir, string(domain), clean)
}

// Restore restores cache into targetDir using copy-on-write (cp --reflink=auto -a) or fallback copy.
// If domain cache doesn't exist, it attempts to fall back to the trusted domain cache.
func (m *Manager) Restore(ctx context.Context, domain egress.TrustDomain, key, targetDir string) (bool, error) {
	src := m.KeyDir(domain, key)
	if _, err := os.Stat(src); os.IsNotExist(err) {
		// Fallback: untrusted or local runs can restore from trusted cache if present
		if domain != egress.TrustDomainTrusted {
			src = m.KeyDir(egress.TrustDomainTrusted, key)
			if _, err := os.Stat(src); os.IsNotExist(err) {
				return false, nil
			}
		} else {
			return false, nil
		}
	}

	if err := os.MkdirAll(filepath.Dir(targetDir), 0755); err != nil {
		return false, fmt.Errorf("mkdir parent %s: %w", targetDir, err)
	}

	// Try copy-on-write with cp --reflink=auto -a <src>/. <targetDir>
	cmd := execx.Cmd{
		Name: "cp",
		Args: []string{"--reflink=auto", "-a", src + "/.", targetDir},
	}
	if err := m.Runner.Run(ctx, cmd); err != nil {
		// Fallback to recursive copy
		if err := copyDir(src, targetDir); err != nil {
			return false, fmt.Errorf("copy fallback failed: %w", err)
		}
	}

	return true, nil
}

// Save persists the contents of sourceDir to the cache for domain and key.
func (m *Manager) Save(ctx context.Context, domain egress.TrustDomain, isProtectedRef bool, key, sourceDir string) error {
	if !CanWrite(domain, isProtectedRef) {
		// Gated: silently skip or return nil
		return nil
	}

	if _, err := os.Stat(sourceDir); os.IsNotExist(err) {
		return nil // Nothing to cache
	}

	dst := m.KeyDir(domain, key)
	tmpDst := dst + ".tmp"
	_ = os.RemoveAll(tmpDst)

	if err := os.MkdirAll(tmpDst, 0755); err != nil {
		return fmt.Errorf("mkdir cache tmp %s: %w", tmpDst, err)
	}

	cmd := execx.Cmd{
		Name: "cp",
		Args: []string{"--reflink=auto", "-a", sourceDir + "/.", tmpDst},
	}
	if err := m.Runner.Run(ctx, cmd); err != nil {
		if err := copyDir(sourceDir, tmpDst); err != nil {
			_ = os.RemoveAll(tmpDst)
			return fmt.Errorf("copy cache failed: %w", err)
		}
	}

	_ = os.RemoveAll(dst)
	if err := os.Rename(tmpDst, dst); err != nil {
		return fmt.Errorf("rename cache tmp to dst: %w", err)
	}

	return nil
}

func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode())
		}
		return copyFile(path, target, info.Mode())
	})
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}
