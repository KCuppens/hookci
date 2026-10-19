// Package source turns "repo + sha" into a checked-out working tree in a
// run directory. Every git call goes through Git, which applies hardened
// flags and a minimal environment.
package source

import (
	"context"
	"errors"
	"syscall"
	"time"
)

// Source is compiled-in. M0: Local. M1: Relay (hub-token fetch into Mirrors).
type Source interface {
	Name() string
	// Checkout materialises req.SHA into dir (which must not exist or be empty).
	Checkout(ctx context.Context, req Request, dir string) (Checkout, error)
}

// Request names the commit to check out.
type Request struct {
	Repo  string              // "owner/name" or "local/<dirname>" for Local
	SHA   string              // full 40-hex sha; Local fills it from HEAD when empty
	Ref   string              // "refs/heads/main" or "refs/pull/12/head"
	RunAs *syscall.Credential // nil means current user; root path sets zeroci-run uid/gid
}

// Checkout describes a materialised working tree.
type Checkout struct {
	Dir      string
	SHA      string
	Ref      string
	Dirty    bool // Local only: working tree had uncommitted changes
	Duration time.Duration
}

var (
	ErrBusy       = errors.New("source: mirror in use")
	ErrBadSHA     = errors.New("source: sha must be 40 hex chars")
	ErrNotGitRepo = errors.New("source: not inside a git repository")
)
