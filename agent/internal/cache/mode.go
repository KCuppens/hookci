package cache

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"

	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

// Mode is how Restore materializes an entry in a workdir.
type Mode string

const (
	ModeReflink Mode = "reflink" // cp --reflink=always per path
	ModeOverlay Mode = "overlay" // mount -t overlay lower=<entry>/<i>,upper,work
	ModeCopy    Mode = "copy"    // portable fallback, full copy
)

// ModeEnv names the environment variable that overrides mode detection.
const ModeEnv = "ZEROCI_CACHE_MODE"

func (m Mode) valid() bool {
	return m == ModeReflink || m == ModeOverlay || m == ModeCopy
}

// DetectMode picks the cheapest copy-on-write mode the cache root supports.
func DetectMode(root string) Mode {
	return detectMode(context.Background(), root, execx.OS{})
}

func detectMode(ctx context.Context, root string, r execx.Runner) Mode {
	if m := Mode(os.Getenv(ModeEnv)); m.valid() {
		return m
	}
	if runtime.GOOS != "linux" {
		return ModeCopy
	}
	if reflinkWorks(ctx, root, r) {
		return ModeReflink
	}
	if os.Geteuid() == 0 && overlayInKernel("/proc/filesystems") {
		return ModeOverlay
	}
	return ModeCopy
}

// reflinkWorks clones a probe file inside root with cp --reflink=always.
func reflinkWorks(ctx context.Context, root string, r execx.Runner) bool {
	src, dst := filepath.Join(root, ".probe-src"), filepath.Join(root, ".probe-dst")
	defer os.Remove(src)
	defer os.Remove(dst)
	_ = os.Remove(dst)
	if err := os.WriteFile(src, []byte("zeroci reflink probe\n"), 0o600); err != nil {
		return false
	}
	return r.Run(ctx, execx.Cmd{Name: "cp", Args: []string{"--reflink=always", ".probe-src", ".probe-dst"}, Dir: root}) == nil
}

// overlayInKernel reports whether the filesystems list names overlay.
func overlayInKernel(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	for line := range bytes.Lines(data) {
		fields := bytes.Fields(line)
		if len(fields) > 0 && string(fields[len(fields)-1]) == "overlay" {
			return true
		}
	}
	return false
}
