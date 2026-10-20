package isolation

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/KCuppens/hookci/agent/internal/execx"
)

// NoneWarning is logged once per None on its first Run.
const NoneWarning = "isolation none: jobs run as your user with no sandbox, no resource limits and full network access"

// defaultGrace is the SIGTERM to SIGKILL delay when None.Grace is zero.
const defaultGrace = 10 * time.Second

// None runs each job as a plain process group of the agent's user. It is for
// local development only: NetNSPath, User, ReadWritePaths, Hide and resource
// limits are ignored. The zero value is ready to use.
type None struct {
	Grace time.Duration // default 10s between SIGTERM and SIGKILL
	Warn  func(string)

	warnOnce sync.Once
	mu       sync.Mutex
	groups   map[string]*execx.Group // live groups keyed by UnitName
}

// Name reports "none".
func (n *None) Name() string { return "none" }

func (n *None) grace() time.Duration {
	if n.Grace > 0 {
		return n.Grace
	}
	return defaultGrace
}

// Run starts spec.Argv as a new process group with exactly spec.Env and
// waits for it. When ctx is done or Limits.Timeout passes, the whole group
// gets SIGTERM, then SIGKILL after Grace.
func (n *None) Run(ctx context.Context, spec Spec) (Result, error) {
	if len(spec.Argv) == 0 {
		return Result{ExitCode: -1}, errors.New("isolation none: empty argv")
	}
	n.warnOnce.Do(func() {
		if n.Warn != nil {
			n.Warn(NoneWarning)
		}
	})

	runCtx := ctx
	if spec.Limits.Timeout > 0 {
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, spec.Limits.Timeout)
		defer cancel()
	}

	env := spec.Env
	if env == nil {
		env = []string{}
	}
	start := time.Now()
	g, err := execx.StartGroup(runCtx, execx.Cmd{
		Name:   spec.Argv[0],
		Args:   spec.Argv[1:],
		Dir:    spec.Dir,
		Env:    env,
		Stdout: spec.Stdout,
		Stderr: spec.Stderr,
	})
	if err != nil {
		return Result{ExitCode: -1}, fmt.Errorf("isolation none: %w", err)
	}
	unit := UnitName(spec.RunID, spec.Job)
	n.track(unit, g)
	defer n.untrack(unit, g)

	type waited struct {
		code int
		err  error
	}
	waitCh := make(chan waited, 1)
	go func() {
		code, err := g.Wait()
		waitCh <- waited{code, err}
	}()

	var w waited
	res := Result{}
	select {
	case w = <-waitCh:
	case <-runCtx.Done():
		select {
		case w = <-waitCh:
			// Finished on its own just as ctx ended.
		default:
			termErr := g.Terminate(n.grace())
			w = <-waitCh
			if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
				res.TimedOut = true
			} else {
				res.Cancelled = true
			}
			if w.err == nil && termErr != nil {
				w.err = termErr
			}
		}
	}
	res.ExitCode = w.code
	res.Duration = time.Since(start)
	if w.err != nil {
		return res, fmt.Errorf("isolation none: %w", w.err)
	}
	return res, nil
}

func (n *None) track(unit string, g *execx.Group) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.groups == nil {
		n.groups = make(map[string]*execx.Group)
	}
	n.groups[unit] = g
}

func (n *None) untrack(unit string, g *execx.Group) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.groups[unit] == g {
		delete(n.groups, unit)
	}
}

// Stop terminates the live group running unit. An unknown unit is already
// gone and is not an error.
func (n *None) Stop(_ context.Context, unit string) error {
	n.mu.Lock()
	g := n.groups[unit]
	n.mu.Unlock()
	if g == nil {
		return nil
	}
	if err := g.Terminate(n.grace()); err != nil {
		return fmt.Errorf("isolation none: stop %s: %w", unit, err)
	}
	return nil
}

// ListUnits returns the live groups whose unit name starts with prefix,
// sorted by name, each with Active "active".
func (n *None) ListUnits(_ context.Context, prefix string) ([]Unit, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	var units []Unit
	for name := range n.groups {
		if strings.HasPrefix(name, prefix) {
			units = append(units, Unit{Name: name, Active: "active"})
		}
	}
	slices.SortFunc(units, func(a, b Unit) int { return strings.Compare(a.Name, b.Name) })
	return units, nil
}
