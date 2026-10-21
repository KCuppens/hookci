//go:build !linux

package cache

import (
	"context"

	"github.com/KCuppens/hookci/agent/internal/execx"
)

func mountOverlay(context.Context, execx.Runner, string, string, string, string) error {
	return ErrModeUnsupported
}

func unmountOverlay(context.Context, execx.Runner, string) error {
	return ErrModeUnsupported
}
