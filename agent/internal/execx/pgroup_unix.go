//go:build unix

package execx

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// Group is a started command that leads its own process group. Every
// process the command forks stays in the group unless it calls setpgid
// itself, so signalling the group reaches background children too.
type Group struct {
	cmd    *exec.Cmd
	pgid   int
	copies sync.WaitGroup
	done   chan struct{}
	code   int
	err    error
}

// StartGroup starts cmd as a new process group leader (Setpgid) and returns
// immediately. ctx is only checked before the start; stop the group with
// Signal or Terminate. c.Env is used exactly, so a nil Env starts the
// command with an empty environment and never inherits the agent's.
//
// When the leader exits, the remaining members of the group are killed
// (like systemd's KillMode=control-group), so no process outlives Wait and
// Wait never blocks on a background child holding stdout or stderr open.
func StartGroup(ctx context.Context, c Cmd) (*Group, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	cmd := exec.Command(c.Name, c.Args...)
	cmd.Dir = c.Dir
	cmd.Env = c.Env
	if cmd.Env == nil {
		cmd.Env = []string{}
	}
	cmd.Stdin = c.Stdin
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Credential: c.Credential}

	g := &Group{cmd: cmd, done: make(chan struct{})}
	var parentEnds []*os.File
	closeParentEnds := func() {
		for _, f := range parentEnds {
			_ = f.Close()
		}
	}
	out, err := g.pipe(c.Stdout)
	if err != nil {
		return nil, err
	}
	if out != nil {
		cmd.Stdout = out
		parentEnds = append(parentEnds, out)
	}
	if out != nil && sameWriter(c.Stdout, c.Stderr) {
		// One pipe for both keeps a single goroutine writing, as os/exec does.
		cmd.Stderr = out
	} else {
		errw, err := g.pipe(c.Stderr)
		if err != nil {
			closeParentEnds()
			return nil, err
		}
		if errw != nil {
			cmd.Stderr = errw
			parentEnds = append(parentEnds, errw)
		}
	}

	if err := cmd.Start(); err != nil {
		closeParentEnds()
		g.copies.Wait()
		return nil, fmt.Errorf("execx: start %s: %w", c.Name, err)
	}
	closeParentEnds()
	g.pgid = cmd.Process.Pid
	go g.wait()
	return g, nil
}

// pipe returns the child's write end of a pipe that is copied into w, or
// nil when w is nil. Passing an *os.File to exec keeps cmd.Wait from waiting
// on the copy, so the leader's exit is observed even while children still
// hold the pipe.
func (g *Group) pipe(w io.Writer) (*os.File, error) {
	if w == nil {
		return nil, nil
	}
	r, wr, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("execx: pipe: %w", err)
	}
	g.copies.Add(1)
	go func() {
		defer g.copies.Done()
		_, _ = io.Copy(w, r)
		_ = r.Close()
	}()
	return wr, nil
}

// sameWriter reports whether a and b are the same comparable writer.
func sameWriter(a, b io.Writer) (same bool) {
	defer func() {
		if recover() != nil {
			same = false
		}
	}()
	return a == b
}

func (g *Group) wait() {
	err := g.cmd.Wait()
	// Kill whatever the leader left behind; the copies end once every
	// holder of the pipes is gone.
	_ = g.Signal(syscall.SIGKILL)
	g.copies.Wait()

	var exitErr *exec.ExitError
	switch {
	case err == nil:
		g.code = 0
	case errors.As(err, &exitErr):
		g.code = exitCode(exitErr.ProcessState)
	default:
		g.code = -1
		g.err = fmt.Errorf("execx: wait %s: %w", g.cmd.Path, err)
	}
	close(g.done)
}

// exitCode maps a finished process to a shell-style code: the exit status,
// or 128 plus the signal number when a signal killed it.
func exitCode(ps *os.ProcessState) int {
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal())
	}
	return ps.ExitCode()
}

// Signal sends sig to every process in the group (kill(-pgid, sig)). A group
// that no longer exists is not an error.
func (g *Group) Signal(sig syscall.Signal) error {
	err := syscall.Kill(-g.pgid, sig)
	if err == nil || errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return fmt.Errorf("execx: signal group %d: %w", g.pgid, err)
}

// Wait blocks until the leader has exited, the rest of the group has been
// killed and all output is copied. A non-zero exit is reported through
// exitCode, not err; err is set only when waiting itself failed.
func (g *Group) Wait() (exitCode int, err error) {
	<-g.done
	return g.code, g.err
}

// Terminate sends SIGTERM to the group, waits up to grace for the leader to
// exit, then sends SIGKILL. It returns once the group is gone.
func (g *Group) Terminate(grace time.Duration) error {
	if err := g.Signal(syscall.SIGTERM); err != nil {
		return err
	}
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-g.done:
		return nil
	case <-timer.C:
	}
	if err := g.Signal(syscall.SIGKILL); err != nil {
		return err
	}
	<-g.done
	return nil
}
