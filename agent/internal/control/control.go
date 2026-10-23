// Package control is the agent's local control socket: the hookci CLI asks
// the running agent to do things (a GC pass, a deploy plan, a retry) over
// <state dir>/control.sock. Each connection carries one JSON request,
// {"op": ..., "body": ...}, and one JSON response, {"ok": true, "result": ...}
// or {"ok": false, "error": ...}.
package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"runtime/debug"
	"sync"
	"syscall"
	"time"
)

// SocketName is the control socket's file name in the agent state dir.
const SocketName = "control.sock"

const (
	maxRequestBytes = 1 << 20
	readTimeout     = 10 * time.Second
	writeTimeout    = 10 * time.Second

	// Accept backoff after a temporary error, as in net/http.
	minAcceptDelay = 5 * time.Millisecond
	maxAcceptDelay = time.Second
)

// ErrNotRunning reports that no agent is listening on the control socket.
var ErrNotRunning = errors.New("agent is not running")

// RemoteError is a handler's error as the client sees it; Error is exactly
// the handler's message.
type RemoteError struct{ Msg string }

func (e *RemoteError) Error() string { return e.Msg }

// HandlerFunc serves one op. body is the request's raw "body"; the result is
// marshalled as the response's "result".
type HandlerFunc func(ctx context.Context, body json.RawMessage) (any, error)

type request struct {
	Op   string          `json:"op"`
	Body json.RawMessage `json:"body"`
}

type response struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// SocketPath returns the control socket path of stateDir.
func SocketPath(stateDir string) string { return filepath.Join(stateDir, SocketName) }

// Server answers control requests on the socket of one state dir.
type Server struct {
	path string
	ln   net.Listener
	log  *slog.Logger

	mu       sync.RWMutex
	handlers map[string]HandlerFunc

	conns     sync.WaitGroup
	closeOnce sync.Once
}

// Listen binds <stateDir>/control.sock with mode 0600, replacing a stale
// socket left by an agent that died. It fails when another agent answers
// on the socket.
func Listen(stateDir string, log *slog.Logger) (*Server, error) {
	path := SocketPath(stateDir)
	if conn, err := net.Dial("unix", path); err == nil {
		_ = conn.Close()
		return nil, fmt.Errorf("control: another agent is serving %s", path)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("control: remove stale socket: %w", err)
	}
	// Bind under a temporary name and rename once the mode is 0600, so the
	// socket is never reachable with looser permissions.
	tmp := path + ".tmp"
	if err := os.Remove(tmp); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("control: remove stale socket: %w", err)
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: tmp, Net: "unix"})
	if err != nil {
		return nil, fmt.Errorf("control: listen: %w", err)
	}
	ln.SetUnlinkOnClose(false)
	if err := os.Chmod(tmp, 0o600); err != nil {
		_ = ln.Close()
		_ = os.Remove(tmp)
		return nil, fmt.Errorf("control: chmod socket: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = ln.Close()
		_ = os.Remove(tmp)
		return nil, fmt.Errorf("control: place socket: %w", err)
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Server{path: path, ln: ln, log: log, handlers: map[string]HandlerFunc{}}, nil
}

// Handle registers h for op, replacing any earlier handler.
func (s *Server) Handle(op string, h HandlerFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handlers[op] = h
}

// Serve answers connections until ctx ends, then closes the socket and waits
// for requests in flight. Handlers get ctx. A temporary accept error (out of
// file descriptors, say) is logged and retried with backoff.
func (s *Server) Serve(ctx context.Context) error {
	stop := context.AfterFunc(ctx, func() { _ = s.Close() })
	defer stop()
	var delay time.Duration
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			if ctx.Err() == nil && !errors.Is(err, net.ErrClosed) && temporaryAcceptErr(err) {
				delay = min(max(2*delay, minAcceptDelay), maxAcceptDelay)
				s.log.Warn("control: accept failed; retrying", "err", err, "delay", delay)
				t := time.NewTimer(delay)
				select {
				case <-t.C:
				case <-ctx.Done():
					t.Stop()
				}
				continue
			}
			_ = s.Close()
			s.conns.Wait()
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			return fmt.Errorf("control: accept: %w", err)
		}
		delay = 0
		s.conns.Go(func() { s.serveConn(ctx, conn) })
	}
}

// temporaryAcceptErr reports whether a later Accept may succeed.
func temporaryAcceptErr(err error) bool {
	if errors.Is(err, syscall.EMFILE) || errors.Is(err, syscall.ENFILE) || errors.Is(err, syscall.ECONNABORTED) {
		return true
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return true
	}
	var te interface{ Temporary() bool }
	return errors.As(err, &te) && te.Temporary()
}

// Close stops accepting connections and removes the socket.
func (s *Server) Close() error {
	var err error
	s.closeOnce.Do(func() {
		err = s.ln.Close()
		if rmErr := os.Remove(s.path); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) && err == nil {
			err = rmErr
		}
		if err != nil {
			err = fmt.Errorf("control: close: %w", err)
		}
	})
	return err
}

func (s *Server) serveConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(readTimeout))
	var req request
	resp := response{}
	if err := json.NewDecoder(io.LimitReader(conn, maxRequestBytes)).Decode(&req); err != nil {
		resp.Error = fmt.Sprintf("control: bad request: %v", err)
	} else {
		result, err := s.call(ctx, req)
		if err != nil {
			resp.Error = err.Error()
		} else if resp.Result, err = json.Marshal(result); err != nil {
			resp.Error = fmt.Sprintf("control: encode %s result: %v", req.Op, err)
		} else {
			resp.OK = true
		}
	}
	_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	if err := json.NewEncoder(conn).Encode(resp); err != nil {
		s.log.Warn("control: write response", "op", req.Op, "err", err)
	}
}

// call runs the handler of req.Op, turning a panic into an error.
func (s *Server) call(ctx context.Context, req request) (result any, err error) {
	s.mu.RLock()
	h, ok := s.handlers[req.Op]
	s.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("control: unknown op %q", req.Op)
	}
	defer func() {
		if v := recover(); v != nil {
			s.log.Error("control: handler panicked", "op", req.Op, "panic", v, "stack", string(debug.Stack()))
			result, err = nil, fmt.Errorf("control: %s crashed: %v", req.Op, v)
		}
	}()
	return h(ctx, req.Body)
}

// Call sends op with body (marshalled as JSON) to the agent of stateDir and
// decodes the result into out when out is non-nil. It returns ErrNotRunning
// when no agent listens, and a *RemoteError when the handler failed.
func Call(ctx context.Context, stateDir, op string, body, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("control: encode %s body: %w", op, err)
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "unix", SocketPath(stateDir))
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ECONNREFUSED) {
		return ErrNotRunning
	}
	if err != nil {
		return fmt.Errorf("control: connect: %w", err)
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	// The agent answers a request it rejects (too large, say) before reading
	// all of it, so a failed send may still have a response waiting.
	sendErr := json.NewEncoder(conn).Encode(request{Op: op, Body: raw})
	var resp response
	if err := json.NewDecoder(conn).Decode(&resp); err != nil {
		if sendErr != nil {
			return callErr(ctx, op, "send", sendErr)
		}
		return callErr(ctx, op, "read", err)
	}
	if !resp.OK {
		return &RemoteError{Msg: resp.Error}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(resp.Result, out); err != nil {
		return fmt.Errorf("control: decode %s result: %w", op, err)
	}
	return nil
}

func callErr(ctx context.Context, op, what string, err error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		err = ctxErr
	}
	return fmt.Errorf("control: %s %s: %w", what, op, err)
}
