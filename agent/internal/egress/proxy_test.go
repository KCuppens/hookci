package egress

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

var npmIP = net.ParseIP("93.184.216.34")

// harness runs a Proxy whose fake dialer routes vetted addresses to a local
// upstream listener and records every dial and decision.
type harness struct {
	t         *testing.T
	p         *Proxy
	mu        sync.Mutex
	dialed    []string
	decisions []Decision
}

// echo copies everything back and half-closes on EOF.
func echo(c net.Conn) {
	_, _ = io.Copy(c, c)
	_ = c.(*net.TCPConn).CloseWrite()
}

// startUpstream serves handle on 127.0.0.1:0 until the test ends.
func startUpstream(t *testing.T, handle func(net.Conn)) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	t.Cleanup(func() {
		_ = ln.Close()
		wg.Wait()
	})
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer c.Close()
				handle(c)
			}()
		}
	}()
	return ln
}

// dialTo returns a DialFunc that records addr, requires it to be in want and
// connects to upstream instead.
func (h *harness) dialTo(upstream net.Listener, want ...string) DialFunc {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		h.mu.Lock()
		h.dialed = append(h.dialed, addr)
		h.mu.Unlock()
		if !slices.Contains(want, addr) {
			h.t.Errorf("dialed %s %s, want one of %v", network, addr, want)
			return nil, errors.New("unexpected dial")
		}
		var d net.Dialer
		return d.DialContext(ctx, network, upstream.Addr().String())
	}
}

// newHarness fills unset Options with the default allow-list, a resolver
// mapping registry.npmjs.org to 93.184.216.34 and a dialer to an echo
// upstream, then starts the proxy.
func newHarness(t *testing.T, opts Options) *harness {
	t.Helper()
	return newHarnessTo(t, opts, nil)
}

// newHarnessTo is newHarness with the fake dialer routed to upstream (an
// echo listener when nil).
func newHarnessTo(t *testing.T, opts Options, upstream net.Listener) *harness {
	t.Helper()
	h := &harness{t: t}
	if opts.Allow == nil {
		allow, _, err := NewAllowList(false, nil)
		if err != nil {
			t.Fatal(err)
		}
		opts.Allow = allow
	}
	if opts.Resolver == nil {
		opts.Resolver = FakeResolver{"registry.npmjs.org": {npmIP}}
	}
	if opts.Dial == nil {
		if upstream == nil {
			upstream = startUpstream(t, echo)
		}
		opts.Dial = h.dialTo(upstream, "93.184.216.34:443")
	}
	opts.RunID = "run-test"
	opts.OnDecision = func(d Decision) {
		h.mu.Lock()
		h.decisions = append(h.decisions, d)
		h.mu.Unlock()
	}
	p, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.Close() })
	h.p = p
	return h
}

func (h *harness) dial() net.Conn {
	h.t.Helper()
	c, err := net.Dial("tcp", h.p.Addr())
	if err != nil {
		h.t.Fatal(err)
	}
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	h.t.Cleanup(func() { _ = c.Close() })
	return c
}

// send writes raw to a new proxy connection and parses the response header.
// The returned reader carries any tunnel bytes after the header.
func (h *harness) send(raw string) (net.Conn, *bufio.Reader, *http.Response) {
	h.t.Helper()
	c := h.dial()
	if _, err := io.WriteString(c, raw); err != nil {
		h.t.Fatal(err)
	}
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		h.t.Fatalf("reading proxy response: %v", err)
	}
	return c, br, resp
}

func (h *harness) connect(target, payload string) (net.Conn, *bufio.Reader, *http.Response) {
	h.t.Helper()
	return h.send(fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n%s", target, target, payload))
}

// expectDenied asserts status, the single decision's reason and a body
// substring, and that nothing was dialed.
func (h *harness) expectDenied(resp *http.Response, status int, reason, body string) {
	h.t.Helper()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != status {
		h.t.Errorf("status = %d, want %d (body %q)", resp.StatusCode, status, b)
	}
	if !strings.Contains(string(b), body) {
		h.t.Errorf("body = %q, want it to contain %q", b, body)
	}
	if !resp.Close {
		h.t.Error("response lacks Connection: close")
	}
	d := h.lastDecision()
	if d.Allowed || d.Reason != reason {
		h.t.Errorf("decision = %+v, want denied with reason %q", d, reason)
	}
	if got := h.dialCount(); got != 0 && reason != reasonDialError {
		h.t.Errorf("dialer called %d times, want 0", got)
	}
}

func (h *harness) lastDecision() Decision {
	h.t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.decisions) != 1 {
		h.t.Fatalf("got %d decisions %+v, want exactly 1", len(h.decisions), h.decisions)
	}
	return h.decisions[0]
}

func (h *harness) dialCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.dialed)
}

func readN(t *testing.T, r io.Reader, n int) string {
	t.Helper()
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		t.Fatalf("reading %d tunnel bytes: %v", n, err)
	}
	return string(b)
}

// waitFor polls cond for up to 2s.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestProxyConnectAllowed(t *testing.T) {
	h := newHarness(t, Options{})
	c, br, resp := h.connect("registry.npmjs.org:443", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if _, err := io.WriteString(c, "ping\n"); err != nil {
		t.Fatal(err)
	}
	if got := readN(t, br, 5); got != "ping\n" {
		t.Fatalf("echo = %q", got)
	}
	h.mu.Lock()
	dialed := slices.Clone(h.dialed)
	h.mu.Unlock()
	if !slices.Equal(dialed, []string{"93.184.216.34:443"}) {
		t.Fatalf("dialed = %v", dialed)
	}
	d := h.lastDecision()
	if !d.Allowed || d.Reason != "allowed" || d.Host != "registry.npmjs.org" || d.Port != 443 || !d.IP.Equal(npmIP) {
		t.Fatalf("decision = %+v", d)
	}
	if s := h.p.Stats(); s.Allowed != 1 || s.Denied != 0 || s.Active != 1 {
		t.Fatalf("stats = %+v", s)
	}
	_ = c.Close()
	waitFor(t, "tunnel to close", func() bool { return h.p.Stats().Active == 0 })
}

func TestProxyNormalizesHost(t *testing.T) {
	h := newHarness(t, Options{})
	_, _, resp := h.connect("Registry.NPMJS.org.:443", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if d := h.lastDecision(); d.Host != "registry.npmjs.org" {
		t.Fatalf("decision host = %q", d.Host)
	}
}

func TestProxyClientBytesAfterHeader(t *testing.T) {
	h := newHarness(t, Options{})
	_, br, resp := h.connect("registry.npmjs.org:443", "hello-upstream")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if got := readN(t, br, len("hello-upstream")); got != "hello-upstream" {
		t.Fatalf("upstream received %q", got)
	}
}

func TestProxyDeniesNotAllowlisted(t *testing.T) {
	h := newHarness(t, Options{})
	_, _, resp := h.connect("evil.example:443", "")
	h.expectDenied(resp, http.StatusForbidden, "not-allowlisted",
		"hookci egress: evil.example is not in the allow-list; add it under checks.egress in .hookci.yml (trusted runs only)")
	if s := h.p.Stats(); s.Denied != 1 || s.Allowed != 0 {
		t.Fatalf("stats = %+v", s)
	}
}

func TestProxyDeniesForbiddenIP(t *testing.T) {
	for name, ips := range map[string][]net.IP{
		"metadata": {net.ParseIP("169.254.169.254")},
		"mixed":    {npmIP, net.ParseIP("127.0.0.1")},
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, Options{Resolver: FakeResolver{"registry.npmjs.org": ips}})
			_, _, resp := h.connect("registry.npmjs.org:443", "")
			h.expectDenied(resp, http.StatusForbidden, "forbidden-ip", "forbidden address")
		})
	}
}

func TestProxyDeniesIPLiteralAndBadPort(t *testing.T) {
	for _, tc := range []struct{ target, reason string }{
		{"93.184.216.34:443", "ip-literal"},
		{"[::1]:443", "ip-literal"},
		{"registry.npmjs.org:80", "bad-port"},
	} {
		t.Run(tc.target, func(t *testing.T) {
			h := newHarness(t, Options{})
			_, _, resp := h.connect(tc.target, "")
			h.expectDenied(resp, http.StatusForbidden, tc.reason, "hookci egress:")
		})
	}
}

func TestProxyRejectsNonConnect(t *testing.T) {
	h := newHarness(t, Options{})
	_, _, resp := h.send("GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n")
	h.expectDenied(resp, http.StatusMethodNotAllowed, "method-not-allowed", "hookci egress: only CONNECT is allowed")
}

func TestProxyRejectsMalformedTarget(t *testing.T) {
	h := newHarness(t, Options{})
	_, _, resp := h.connect("registry.npmjs.org", "")
	h.expectDenied(resp, http.StatusBadRequest, "bad-request", "hookci egress:")
}

func TestProxyDNSErrorAndDialError(t *testing.T) {
	t.Run("dns", func(t *testing.T) {
		allow, _, err := NewAllowList(true, []string{"unknown.example"})
		if err != nil {
			t.Fatal(err)
		}
		h := newHarness(t, Options{Allow: allow})
		_, _, resp := h.connect("unknown.example:443", "")
		h.expectDenied(resp, http.StatusBadGateway, "dns-error", "cannot resolve unknown.example")
	})
	t.Run("dial", func(t *testing.T) {
		h := newHarness(t, Options{Dial: func(context.Context, string, string) (net.Conn, error) {
			return nil, errors.New("connection refused")
		}})
		_, _, resp := h.connect("registry.npmjs.org:443", "")
		h.expectDenied(resp, http.StatusBadGateway, "dial-error", "cannot connect to registry.npmjs.org")
	})
}

func TestProxyDialTriesNextAddress(t *testing.T) {
	second := net.ParseIP("93.184.216.35")
	upstream := startUpstream(t, echo)
	var mu sync.Mutex
	var dialed []string
	next := func(ctx context.Context, network, addr string) (net.Conn, error) {
		mu.Lock()
		dialed = append(dialed, addr)
		mu.Unlock()
		if addr == "93.184.216.34:443" {
			return nil, errors.New("connection refused")
		}
		var d net.Dialer
		return d.DialContext(ctx, network, upstream.Addr().String())
	}
	h := newHarness(t, Options{Resolver: FakeResolver{"registry.npmjs.org": {npmIP, second}}, Dial: next})
	_, _, resp := h.connect("registry.npmjs.org:443", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if d := h.lastDecision(); !d.IP.Equal(second) {
		t.Fatalf("decision IP = %v, want %v", d.IP, second)
	}
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(dialed, []string{"93.184.216.34:443", "93.184.216.35:443"}) {
		t.Fatalf("dialed = %v, want both addresses in order", dialed)
	}
}

func TestProxyHeaderTimeout(t *testing.T) {
	h := newHarness(t, Options{HeaderTimeout: 50 * time.Millisecond})
	c := h.dial()
	start := time.Now()
	b, err := io.ReadAll(c)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("connection stayed open %v", elapsed)
	}
	if !strings.HasPrefix(string(b), "HTTP/1.1 400 ") {
		t.Fatalf("response = %q, want 400", b)
	}
	if d := h.lastDecision(); d.Reason != "bad-request" {
		t.Fatalf("decision = %+v", d)
	}
}

func TestProxyHeaderTooLarge(t *testing.T) {
	h := newHarness(t, Options{})
	_, _, resp := h.send("CONNECT registry.npmjs.org:443 HTTP/1.1\r\nX-Pad: " + strings.Repeat("a", 9000) + "\r\n\r\n")
	h.expectDenied(resp, http.StatusBadRequest, "bad-request", "hookci egress: bad request")
}

func TestProxyMaxConns(t *testing.T) {
	h := newHarness(t, Options{MaxConns: 1})
	_, _, first := h.connect("registry.npmjs.org:443", "")
	if first.StatusCode != http.StatusOK {
		t.Fatalf("first status = %d", first.StatusCode)
	}
	_, _, second := h.connect("registry.npmjs.org:443", "")
	b, _ := io.ReadAll(second.Body)
	if second.StatusCode != http.StatusServiceUnavailable || !strings.Contains(string(b), "hookci egress: too many connections") {
		t.Fatalf("second = %d %q, want 503 too many connections", second.StatusCode, b)
	}
	if s := h.p.Stats(); s.Active != 1 || s.Allowed != 1 || s.Denied != 1 {
		t.Fatalf("stats = %+v", s)
	}
}

func TestProxyIdleTimeout(t *testing.T) {
	h := newHarness(t, Options{IdleTimeout: 100 * time.Millisecond})
	_, br, resp := h.connect("registry.npmjs.org:443", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	start := time.Now()
	if _, err := br.ReadByte(); err == nil {
		t.Fatal("idle tunnel read returned data")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatalf("tunnel not closed by the proxy: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("idle tunnel lived %v", elapsed)
	}
	waitFor(t, "active tunnels to drop", func() bool { return h.p.Stats().Active == 0 })
}

func TestProxyIdleTimeoutCountsEitherDirection(t *testing.T) {
	sink := startUpstream(t, func(c net.Conn) { _, _ = io.Copy(io.Discard, c) })
	h := newHarnessTo(t, Options{IdleTimeout: 100 * time.Millisecond}, sink)
	c, _, resp := h.connect("registry.npmjs.org:443", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	// Upload only: the upstream never sends, but the tunnel must stay open
	// while bytes keep moving client to upstream.
	for range 10 {
		if _, err := io.WriteString(c, "x"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(30 * time.Millisecond)
	}
	if s := h.p.Stats(); s.Active != 1 {
		t.Fatalf("tunnel closed during one-way traffic: %+v", s)
	}
	waitFor(t, "idle tunnel to close", func() bool { return h.p.Stats().Active == 0 })
}

func TestProxyCloseTearsDownTunnels(t *testing.T) {
	h := newHarness(t, Options{})
	c, br, resp := h.connect("registry.npmjs.org:443", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	start := time.Now()
	if err := h.p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("Close took %v", elapsed)
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err := br.ReadByte()
	if err == nil {
		t.Fatal("client read succeeded after Close")
	}
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatalf("client read timed out instead of seeing the tunnel close: %v", err)
	}
	if s := h.p.Stats(); s.Active != 0 {
		t.Fatalf("stats after Close = %+v", s)
	}
	if _, err := net.Dial("tcp", h.p.Addr()); err == nil {
		t.Fatal("proxy still accepting after Close")
	}
}

func TestProxyStopsWhenContextDone(t *testing.T) {
	allow, _, err := NewAllowList(false, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	p, err := Start(ctx, Options{Allow: allow, Resolver: FakeResolver{}})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if err := p.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := net.Dial("tcp", p.Addr()); err == nil {
		t.Fatal("proxy still accepting after ctx done")
	}
}

func TestStartRequiresAllowList(t *testing.T) {
	if _, err := Start(context.Background(), Options{}); err == nil {
		t.Fatal("Start without Allow succeeded")
	}
}

func TestProxyWithHTTPTransport(t *testing.T) {
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ping" {
			http.NotFound(w, r)
			return
		}
		_, _ = io.WriteString(w, "pong")
	}))
	t.Cleanup(ts.Close)

	h := newHarnessTo(t, Options{}, ts.Listener)

	tr := ts.Client().Transport.(*http.Transport).Clone()
	tr.Proxy = http.ProxyURL(&url.URL{Scheme: "http", Host: h.p.Addr()})
	tr.TLSClientConfig.ServerName = "example.com" // a name in the httptest certificate
	t.Cleanup(tr.CloseIdleConnections)
	client := &http.Client{Transport: tr, Timeout: 5 * time.Second}

	resp, err := client.Get("https://registry.npmjs.org/ping")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(b) != "pong" {
		t.Fatalf("got %d %q, want 200 pong", resp.StatusCode, b)
	}
	if d := h.lastDecision(); !d.Allowed || d.Host != "registry.npmjs.org" {
		t.Fatalf("decision = %+v", d)
	}
}
