// Package proxy holds the compiled-in ProxyAdapter interface (plan §2): the
// blue/green swap renders a route for the target color, writes it
// atomically and reloads the reverse proxy.
package proxy

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
)

// RouteSpec is the public route of one deployment environment.
type RouteSpec struct {
	Repo, Env    string
	Color        string // "blue" | "green", written as a comment only
	UpstreamHost string // default "127.0.0.1"
	Port         int
}

// ProxyAdapter renders, writes and activates a route file for one reverse
// proxy implementation.
type ProxyAdapter interface {
	Render(route RouteSpec) ([]byte, error)
	Apply(ctx context.Context, file string, content []byte) (prev []byte, err error)
	Reload(ctx context.Context) error
}

// ApplyAndReload writes content, reloads, and on reload failure restores prev and reloads again.
// A nil prev means the file did not exist before, so the restore removes it.
func ApplyAndReload(ctx context.Context, a ProxyAdapter, file string, content []byte) error {
	prev, err := a.Apply(ctx, file, content)
	if err != nil {
		return fmt.Errorf("proxy: apply route %s: %w", file, err)
	}
	reloadErr := a.Reload(ctx)
	if reloadErr == nil {
		return nil
	}

	if err := restore(ctx, a, file, prev); err != nil {
		return fmt.Errorf("route reload failed and restoring the previous route failed; check route.reload: %w; restore: %w", reloadErr, err)
	}
	if err := a.Reload(ctx); err != nil {
		return fmt.Errorf("route reload failed and reloading the restored previous route failed; check route.reload: %w; restore reload: %w", reloadErr, err)
	}
	return fmt.Errorf("route reload failed, previous route restored: %w", reloadErr)
}

// restore writes prev back to file, or removes file when prev is nil.
func restore(ctx context.Context, a ProxyAdapter, file string, prev []byte) error {
	if prev == nil {
		if err := os.Remove(file); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("proxy: remove route %s: %w", file, err)
		}
		return nil
	}
	if _, err := a.Apply(ctx, file, prev); err != nil {
		return fmt.Errorf("proxy: apply previous route %s: %w", file, err)
	}
	return nil
}
