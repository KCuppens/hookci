//go:build !unix

package execx

import (
	"context"
	"errors"
	"syscall"
	"time"
)

// ErrGroupUnsupported is returned by StartGroup on hosts without POSIX
// process groups.
var ErrGroupUnsupported = errors.New("execx: process groups are unsupported on this host")

// Group is a started command that leads its own process group. Process
// groups need a unix host; this build only has the stub.
type Group struct{}

// StartGroup always fails with ErrGroupUnsupported on non-unix hosts.
func StartGroup(context.Context, Cmd) (*Group, error) { return nil, ErrGroupUnsupported }

// Signal always fails with ErrGroupUnsupported on non-unix hosts.
func (*Group) Signal(syscall.Signal) error { return ErrGroupUnsupported }

// Wait always fails with ErrGroupUnsupported on non-unix hosts.
func (*Group) Wait() (int, error) { return -1, ErrGroupUnsupported }

// Terminate always fails with ErrGroupUnsupported on non-unix hosts.
func (*Group) Terminate(time.Duration) error { return ErrGroupUnsupported }
