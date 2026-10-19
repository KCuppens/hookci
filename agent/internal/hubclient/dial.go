package hubclient

import (
	"context"
	"fmt"
	"net/http"

	"github.com/coder/websocket"
)

// maxFrameBytes matches the hub's MAX_FRAME_BYTES.
const maxFrameBytes = 1 << 20

// Dialer opens a WebSocket to the hub.
type Dialer interface {
	Dial(ctx context.Context, url string, h http.Header) (Conn, error)
}

// Conn is one WebSocket connection. Read and Write may run concurrently with
// each other, but not with themselves.
type Conn interface {
	Read(ctx context.Context) ([]byte, error)
	Write(ctx context.Context, b []byte) error
	Close(code int, reason string) error
}

// StatusError is a refused WebSocket upgrade: the hub answered with an HTTP
// status other than 101.
type StatusError struct {
	StatusCode int
	Err        error
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("hubclient: dial: hub answered HTTP %d: %v", e.StatusCode, e.Err)
}

func (e *StatusError) Unwrap() error { return e.Err }

// WebSocketDialer is the real Dialer, built on github.com/coder/websocket.
type WebSocketDialer struct {
	// HTTPClient is used for the upgrade request; nil uses http.DefaultClient.
	HTTPClient *http.Client
}

// Dial opens the connection. A refused upgrade returns a *StatusError.
func (d WebSocketDialer) Dial(ctx context.Context, url string, h http.Header) (Conn, error) {
	c, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: d.HTTPClient, HTTPHeader: h})
	if err != nil {
		if resp != nil && resp.StatusCode != 0 && resp.StatusCode != http.StatusSwitchingProtocols {
			return nil, &StatusError{StatusCode: resp.StatusCode, Err: err}
		}
		return nil, fmt.Errorf("hubclient: dial: %w", err)
	}
	c.SetReadLimit(maxFrameBytes)
	return wsConn{c}, nil
}

type wsConn struct{ c *websocket.Conn }

func (w wsConn) Read(ctx context.Context) ([]byte, error) {
	_, b, err := w.c.Read(ctx)
	if err != nil {
		return nil, fmt.Errorf("hubclient: read: %w", err)
	}
	return b, nil
}

func (w wsConn) Write(ctx context.Context, b []byte) error {
	if err := w.c.Write(ctx, websocket.MessageText, b); err != nil {
		return fmt.Errorf("hubclient: write: %w", err)
	}
	return nil
}

func (w wsConn) Close(code int, reason string) error {
	if err := w.c.Close(websocket.StatusCode(code), reason); err != nil {
		return fmt.Errorf("hubclient: close: %w", err)
	}
	return nil
}
