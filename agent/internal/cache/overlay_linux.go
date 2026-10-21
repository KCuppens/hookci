//go:build linux

package cache

import (
	"context"
	"fmt"
	"strings"

	"github.com/KCuppens/hookci/agent/internal/execx"
)

// mountOverlay mounts an overlay at target with lower as the read-only
// snapshot and upper/work as the per-run writable layer.
func mountOverlay(ctx context.Context, r execx.Runner, lower, upper, work, target string) error {
	for _, p := range []string{lower, upper, work} {
		// The kernel splits mount options on commas and lowerdir on colons.
		if strings.ContainsAny(p, ",:") {
			return fmt.Errorf("%w: overlay dir %q contains ',' or ':'", ErrBadPath, p)
		}
	}
	opts := "lowerdir=" + lower + ",upperdir=" + upper + ",workdir=" + work
	if err := r.Run(ctx, execx.Cmd{Name: "mount", Args: []string{"-t", "overlay", "overlay", "-o", opts, target}}); err != nil {
		return fmt.Errorf("cache: mount overlay on %s: %w", target, err)
	}
	return nil
}

func unmountOverlay(ctx context.Context, r execx.Runner, target string) error {
	if err := r.Run(ctx, execx.Cmd{Name: "umount", Args: []string{target}}); err != nil {
		return fmt.Errorf("cache: unmount overlay %s: %w", target, err)
	}
	return nil
}
