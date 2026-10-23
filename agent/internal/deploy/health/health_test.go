package health

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KCuppens/hookci/agent/internal/clock"
)

var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// autoClock is a fake clock whose After fires immediately by advancing the
// fake time, so Wait never blocks and the elapsed fake time is observable.
type autoClock struct{ *clock.Fake }

func (a autoClock) After(d time.Duration) <-chan time.Time {
	ch := a.Fake.After(d)
	a.Advance(d)
	return ch
}

// serverPort starts an httptest server running h and returns its port.
func serverPort(t *testing.T, h http.HandlerFunc) int {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	_, port, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	p, err := strconv.Atoi(port)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestWait_SucceedsAfterRetries(t *testing.T) {
	var hits atomic.Int32
	port := serverPort(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		if hits.Add(1) <= 2 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	clk := autoClock{clock.NewFake(epoch)}
	c := &Checker{Clock: clk}

	err := c.Wait(context.Background(), Spec{
		Env:      "production",
		URL:      "http://127.0.0.1:{port}/health",
		Port:     port,
		Interval: 2 * time.Second,
	})
	if err != nil {
		t.Fatalf("Wait: %v", err)
	}
	if got := hits.Load(); got != 3 {
		t.Errorf("hits = %d, want 3", got)
	}
	if got := clk.Now().Sub(epoch); got != 4*time.Second {
		t.Errorf("fake clock advanced %v, want exactly 2 intervals (4s)", got)
	}
}

func TestWait_ErrorFormat(t *testing.T) {
	body := strings.Repeat("0123456789", 200)
	port := serverPort(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(body))
	})
	c := &Checker{Clock: autoClock{clock.NewFake(epoch)}}

	err := c.Wait(context.Background(), Spec{
		Env:     "production",
		URL:     "http://127.0.0.1:{port}/health",
		Port:    port,
		Retries: 3,
	})
	want := "deployments.production.health: 502 after 3 tries, last body: " + body[:512] +
		"; check health.url or raise health.retries"
	if err == nil || err.Error() != want {
		t.Fatalf("error =\n%v\nwant\n%s", err, want)
	}
}

func TestWait_ConnectionRefused(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	c := &Checker{Clock: autoClock{clock.NewFake(epoch)}}

	err = c.Wait(context.Background(), Spec{
		Env:     "staging",
		URL:     "http://127.0.0.1:{port}/health",
		Port:    port,
		Retries: 3,
	})
	want := "deployments.staging.health: connection refused after 3 tries, last body: ; check health.url or raise health.retries"
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %s", err, want)
	}
}

func TestWait_ContextCancel(t *testing.T) {
	var hits atomic.Int32
	first := make(chan struct{})
	port := serverPort(t, func(w http.ResponseWriter, _ *http.Request) {
		if hits.Add(1) == 1 {
			close(first)
		}
		w.WriteHeader(http.StatusBadGateway)
	})
	// A fake clock nobody advances: without cancellation Wait would block
	// forever between the first and second attempt.
	clk := clock.NewFake(epoch)
	c := &Checker{Clock: clk}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- c.Wait(ctx, Spec{Env: "production", URL: "http://127.0.0.1:{port}/", Port: port, Retries: 40})
	}()
	<-first
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Wait error = %v, want context.Canceled", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Wait did not return after cancel")
	}
	if got := hits.Load(); got != 1 {
		t.Errorf("hits = %d, want 1", got)
	}
	if !clk.Now().Equal(epoch) {
		t.Errorf("fake clock advanced to %v", clk.Now())
	}
}

func TestExpandURL(t *testing.T) {
	cases := []struct{ raw, want string }{
		{"http://127.0.0.1:8080/health", "http://127.0.0.1:8080/health"},
		{"http://127.0.0.1:{port}/health", "http://127.0.0.1:3101/health"},
		{"http://127.0.0.1:{port}/health?port={port}", "http://127.0.0.1:3101/health?port=3101"},
	}
	for _, tc := range cases {
		if got := ExpandURL(tc.raw, 3101); got != tc.want {
			t.Errorf("ExpandURL(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

func TestProbe_DoesNotFollowNonLoopbackRedirect(t *testing.T) {
	port := serverPort(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://hookci.invalid/health", http.StatusFound)
	})
	c := &Checker{}

	status, _, err := c.Probe(context.Background(), Spec{URL: "http://127.0.0.1:{port}/", Port: port})
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if status != http.StatusFound {
		t.Errorf("status = %d, want 302", status)
	}
}

func TestProbe_FollowsLoopbackRedirect(t *testing.T) {
	port := serverPort(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/old" {
			http.Redirect(w, r, "/health", http.StatusMovedPermanently)
			return
		}
		_, _ = w.Write([]byte("ok"))
	})
	c := &Checker{}

	status, body, err := c.Probe(context.Background(), Spec{URL: "http://localhost:{port}/old", Port: port})
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if status != http.StatusOK || body != "ok" {
		t.Errorf("Probe = %d %q, want 200 \"ok\"", status, body)
	}
}

func TestProbe_TimeoutIsInterval(t *testing.T) {
	port := serverPort(t, func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	})
	c := &Checker{}

	_, _, err := c.Probe(context.Background(), Spec{URL: "http://127.0.0.1:{port}/", Port: port, Interval: 20 * time.Millisecond})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Probe error = %v, want deadline exceeded", err)
	}
	if got := describe(err); got != "timeout" {
		t.Errorf("describe = %q, want timeout", got)
	}
}
