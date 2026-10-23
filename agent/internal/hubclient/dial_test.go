package hubclient

import (
	"context"
	"errors"
	"net"
	"net/http"
	"testing"
	"time"
)

// A hub that accepts the TCP connection but never answers the upgrade must
// not hold Dial forever.
func TestDialTimesOutStalledUpgrade(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	held := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			held <- c
		}
	}()
	defer func() {
		select {
		case c := <-held:
			c.Close()
		default:
		}
	}()

	start := time.Now()
	_, err = WebSocketDialer{Timeout: 100 * time.Millisecond}.Dial(context.Background(), "ws://"+ln.Addr().String()+"/v1/agent/connect", http.Header{})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Dial error = %v, want context.DeadlineExceeded", err)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("Dial took %s", took)
	}
}
