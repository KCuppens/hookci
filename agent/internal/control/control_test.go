package control

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
)

// serve starts a Server on a fresh state dir and stops it at test end.
func serve(t *testing.T, handlers map[string]HandlerFunc) string {
	t.Helper()
	dir := t.TempDir()
	s, err := Listen(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	for op, h := range handlers {
		s.Handle(op, h)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("Serve: %v", err)
		}
	})
	return dir
}

func TestCall_RoundTrip(t *testing.T) {
	dir := serve(t, map[string]HandlerFunc{
		"echo": func(_ context.Context, body json.RawMessage) (any, error) {
			var in struct{ N int }
			if err := json.Unmarshal(body, &in); err != nil {
				return nil, err
			}
			return map[string]int{"n": in.N + 1}, nil
		},
	})
	var out struct{ N int }
	if err := Call(context.Background(), dir, "echo", map[string]int{"n": 41}, &out); err != nil {
		t.Fatal(err)
	}
	if out.N != 42 {
		t.Errorf("n = %d, want 42", out.N)
	}
	info, err := os.Stat(SocketPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("socket mode = %o, want 600", perm)
	}
}

func TestCall_Errors(t *testing.T) {
	dir := serve(t, map[string]HandlerFunc{
		"fail":  func(context.Context, json.RawMessage) (any, error) { return nil, errors.New("env lock held") },
		"panic": func(context.Context, json.RawMessage) (any, error) { panic("bug") },
	})
	ctx := context.Background()

	var remote *RemoteError
	if err := Call(ctx, dir, "fail", nil, nil); !errors.As(err, &remote) || err.Error() != "env lock held" {
		t.Errorf("fail: err = %v, want RemoteError \"env lock held\"", err)
	}
	if err := Call(ctx, dir, "panic", nil, nil); !errors.As(err, &remote) || err.Error() != "control: panic crashed: bug" {
		t.Errorf("panic: err = %v", err)
	}
	if err := Call(ctx, dir, "nope", nil, nil); err == nil || err.Error() != `control: unknown op "nope"` {
		t.Errorf("unknown op: err = %v", err)
	}
}

func TestCall_NotRunning(t *testing.T) {
	dir := t.TempDir()
	if err := Call(context.Background(), dir, "gc", nil, nil); !errors.Is(err, ErrNotRunning) {
		t.Errorf("no socket: err = %v, want ErrNotRunning", err)
	}

	// A socket file nobody listens on, as a crashed agent leaves behind.
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: SocketPath(dir), Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	ln.SetUnlinkOnClose(false)
	_ = ln.Close()
	if err := Call(context.Background(), dir, "gc", nil, nil); !errors.Is(err, ErrNotRunning) {
		t.Errorf("stale socket: err = %v, want ErrNotRunning", err)
	}
}

func TestListen_ReplacesStaleSocketAndRefusesLiveOne(t *testing.T) {
	dir := t.TempDir()
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: SocketPath(dir), Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Listen(dir, nil); err == nil || !strings.Contains(err.Error(), "another agent is serving") {
		t.Errorf("live socket: err = %v", err)
	}
	ln.SetUnlinkOnClose(false)
	_ = ln.Close()

	s, err := Listen(dir, nil)
	if err != nil {
		t.Fatalf("stale socket: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(SocketPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("socket after Close: %v, want removed", err)
	}
}

func TestServe_RejectsOversizedRequest(t *testing.T) {
	called := false
	dir := serve(t, map[string]HandlerFunc{
		"big": func(context.Context, json.RawMessage) (any, error) { called = true; return nil, nil },
	})
	err := Call(context.Background(), dir, "big", strings.Repeat("x", maxRequestBytes), nil)
	if err == nil || !strings.Contains(err.Error(), "control: bad request") {
		t.Errorf("err = %v, want bad request", err)
	}
	if called {
		t.Error("handler ran for an oversized request")
	}
}

// flakyListener fails the first fails Accepts with EMFILE, as when the agent
// briefly runs out of file descriptors.
type flakyListener struct {
	net.Listener
	fails atomic.Int32
}

func (l *flakyListener) Accept() (net.Conn, error) {
	if l.fails.Add(-1) >= 0 {
		return nil, &net.OpError{Op: "accept", Net: "unix", Err: os.NewSyscallError("accept4", syscall.EMFILE)}
	}
	return l.Listener.Accept()
}

func TestServe_SurvivesTemporaryAcceptError(t *testing.T) {
	dir := t.TempDir()
	s, err := Listen(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	fl := &flakyListener{Listener: s.ln}
	fl.fails.Store(3)
	s.ln = fl
	s.Handle("ping", func(context.Context, json.RawMessage) (any, error) { return "pong", nil })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Serve(ctx) }()

	var out string
	if err := Call(context.Background(), dir, "ping", nil, &out); err != nil || out != "pong" {
		t.Errorf("Call = %q, %v; want pong", out, err)
	}
	if fl.fails.Load() >= 0 {
		t.Error("Serve did not go through the temporary accept errors")
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("Serve: %v", err)
	}
}
