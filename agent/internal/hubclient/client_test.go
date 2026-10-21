package hubclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/KCuppens/hookci/agent/internal/clock"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/store"
)

const testCredential = "hci_agent_secretsecretsecret"

// fakeHub serves /v1/agent/connect. While refuse is non-zero it answers the
// upgrade with that HTTP status; otherwise it accepts and hands the socket to
// the test through conns.
type fakeHub struct {
	srv      *httptest.Server
	refuse   atomic.Int32
	requests atomic.Int32
	accepted atomic.Int32
	conns    chan *hubConn
}

type hubConn struct {
	c      *websocket.Conn
	header http.Header
}

func newFakeHub(t *testing.T) *fakeHub {
	t.Helper()
	h := &fakeHub{conns: make(chan *hubConn, 8)}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agent/connect" {
			http.NotFound(w, r)
			return
		}
		h.requests.Add(1)
		if code := h.refuse.Load(); code != 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(int(code))
			_, _ = w.Write([]byte(`{"error":"revoked"}`))
			return
		}
		h.accepted.Add(1)
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		h.conns <- &hubConn{c: c, header: r.Header.Clone()}
	}))
	t.Cleanup(h.srv.Close)
	return h
}

func (h *fakeHub) next(t *testing.T) *hubConn {
	t.Helper()
	select {
	case c := <-h.conns:
		t.Cleanup(func() { c.c.CloseNow() })
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("client never connected to the fake hub")
		return nil
	}
}

func (c *hubConn) read(t *testing.T) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, b, err := c.c.Read(ctx)
	if err != nil {
		t.Fatalf("hub read: %v", err)
	}
	return b
}

func (c *hubConn) readFrame(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(c.read(t), &m); err != nil {
		t.Fatalf("hub read: %v", err)
	}
	return m
}

func (c *hubConn) send(t *testing.T, raw string) {
	t.Helper()
	if err := c.c.Write(context.Background(), websocket.MessageText, []byte(raw)); err != nil {
		t.Fatalf("hub write: %v", err)
	}
}

const welcomeFrame = `{"v":1,"type":"welcome","hub_version":"test","protocol_min":1,"protocol_max":1,"agent_id":"agt_1","installation_id":42}`

func (c *hubConn) handshake(t *testing.T) map[string]any {
	t.Helper()
	hello := c.readFrame(t)
	if hello["type"] != "hello" {
		t.Fatalf("first frame = %v, want hello", hello)
	}
	c.send(t, welcomeFrame)
	return hello
}

// drain keeps reading so the hub side answers the client's close handshake.
func (c *hubConn) drain() {
	go func() {
		for {
			if _, _, err := c.c.Read(context.Background()); err != nil {
				return
			}
		}
	}()
}

type recordingHandler struct {
	mu     sync.Mutex
	frames []protocol.Frame
	fail   int // fail this many calls before recording frames
}

func (h *recordingHandler) HandleFrame(_ context.Context, f protocol.Frame) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.fail > 0 {
		h.fail--
		return errors.New("store busy")
	}
	h.frames = append(h.frames, f)
	return nil
}

func (h *recordingHandler) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.frames)
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type harness struct {
	hub    *fakeHub
	st     *store.Store
	clk    *clock.Fake
	client *Client
	logs   *syncBuffer
	h      *recordingHandler
	errc   chan error
	cancel context.CancelFunc
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	x := &harness{
		hub:  newFakeHub(t),
		st:   st,
		clk:  clock.NewFake(time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)),
		logs: &syncBuffer{},
		h:    &recordingHandler{},
		errc: make(chan error, 1),
	}
	x.client = New(Config{
		HubURL:     x.hub.srv.URL,
		AgentID:    "agt_1",
		Credential: testCredential,
		Version:    "1.2.3",
		Clock:      x.clk,
	}, st, x.h, slog.New(slog.NewTextHandler(x.logs, nil)))
	return x
}

func (x *harness) start(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	x.cancel = cancel
	go func() { x.errc <- x.client.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-x.errc:
		case <-time.After(10 * time.Second):
			t.Error("Run did not return after cancel")
		}
	})
}

func (x *harness) runErr(t *testing.T) error {
	t.Helper()
	select {
	case err := <-x.errc:
		x.errc <- err // let the cleanup drain it
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return")
		return nil
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// advanceUntil steps the fake clock one second at a time until cond holds,
// letting backoff timers fire.
func advanceUntil(t *testing.T, clk *clock.Fake, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		clk.Advance(time.Second)
		time.Sleep(10 * time.Millisecond)
	}
}

func TestHelloWelcome(t *testing.T) {
	x := newHarness(t)
	if err := x.st.SetHWM(context.Background(), store.HWMIn, 7); err != nil {
		t.Fatal(err)
	}
	x.start(t)
	c := x.hub.next(t)

	if got := c.header.Get("Authorization"); got != "Bearer "+testCredential {
		t.Errorf("Authorization = %q", got)
	}
	if got := c.header.Get("User-Agent"); got != "hookci-agent/1.2.3" {
		t.Errorf("User-Agent = %q", got)
	}
	hello := c.readFrame(t)
	want := map[string]any{"v": 1.0, "type": "hello", "protocol_version": 1.0, "agent_version": "1.2.3", "inbound_hwm": 7.0, "agent_id": "agt_1"}
	for k, v := range want {
		if hello[k] != v {
			t.Errorf("hello[%q] = %v, want %v", k, hello[k], v)
		}
	}
	if x.client.Connected() {
		t.Fatal("Connected() before welcome")
	}
	c.send(t, welcomeFrame)
	waitFor(t, "Connected()", x.client.Connected)
	if strings.Contains(x.logs.String(), testCredential) {
		t.Error("credential appears in logs")
	}
}

func TestReplayAfterReconnect(t *testing.T) {
	x := newHarness(t)
	x.hub.refuse.Store(http.StatusServiceUnavailable)
	x.start(t)
	waitFor(t, "first refused dial", func() bool { return x.hub.requests.Load() >= 1 })

	ctx := context.Background()
	frames := []protocol.Frame{
		protocol.Accepted{TriggerId: "trg_1", RunId: "run_1"},
		protocol.TokenRequest{RunId: "run_1", Purpose: protocol.TokenRequestPurposeFetch},
		protocol.Rejected{TriggerId: "trg_2", Reason: "no_config"},
	}
	for i, f := range frames {
		seq, err := x.client.Send(ctx, f)
		if err != nil {
			t.Fatal(err)
		}
		if seq != int64(i+1) {
			t.Fatalf("Send #%d seq = %d", i, seq)
		}
	}
	if x.client.Connected() {
		t.Fatal("Connected() while the hub is down")
	}

	x.hub.refuse.Store(0)
	advanceUntil(t, x.clk, "reconnect", func() bool { return x.hub.accepted.Load() >= 1 })
	c := x.hub.next(t)
	c.handshake(t)

	wantTypes := []string{"accepted", "token_request", "rejected"}
	for i, wt := range wantTypes {
		m := c.readFrame(t)
		if m["type"] != wt || m["seq"] != float64(i+1) {
			t.Fatalf("frame %d = %v, want type %s seq %d", i, m, wt, i+1)
		}
	}
	c.send(t, `{"v":1,"type":"ack","upto":3}`)
	waitFor(t, "outbox drained", func() bool {
		items, err := x.st.Pending(ctx, 0, 0)
		return err == nil && len(items) == 0
	})
}

func TestInboundDedupe(t *testing.T) {
	x := newHarness(t)
	x.start(t)
	c := x.hub.next(t)
	c.handshake(t)

	token := `{"v":1,"type":"token","seq":5,"run_id":"run_1","token":"ghs_x","exp":1700000000}`
	c.send(t, token)
	c.send(t, token)
	for i := range 2 {
		m := c.readFrame(t)
		if m["type"] != "ack" || m["upto"] != 5.0 {
			t.Fatalf("reply %d = %v, want ack upto 5", i, m)
		}
	}
	if n := x.h.count(); n != 1 {
		t.Fatalf("HandleFrame called %d times, want 1", n)
	}
	if _, ok := x.h.frames[0].(protocol.Token); !ok {
		t.Fatalf("handler got %T, want protocol.Token", x.h.frames[0])
	}
	hwm, err := x.st.GetHWM(context.Background(), store.HWMIn)
	if err != nil || hwm != 5 {
		t.Fatalf("inbound hwm = %d, %v; want 5", hwm, err)
	}
}

func TestFailedFrameNotAcked(t *testing.T) {
	x := newHarness(t)
	x.h.fail = 1
	x.start(t)
	c := x.hub.next(t)
	c.handshake(t)

	token := `{"v":1,"type":"token","seq":5,"run_id":"run_1","token":"ghs_x","exp":1700000000}`
	c.send(t, token)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, b, err := c.c.Read(ctx)
		if err != nil {
			break
		}
		if strings.Contains(string(b), `"ack"`) {
			t.Fatalf("failed frame acknowledged: %s", b)
		}
	}
	if hwm, err := x.st.GetHWM(context.Background(), store.HWMIn); err != nil || hwm != 0 {
		t.Fatalf("inbound hwm after failure = %d, %v; want 0", hwm, err)
	}

	advanceUntil(t, x.clk, "reconnect", func() bool { return x.hub.accepted.Load() >= 2 })
	c = x.hub.next(t)
	if hello := c.handshake(t); hello["inbound_hwm"] != 0.0 {
		t.Fatalf("hello inbound_hwm = %v, want 0", hello["inbound_hwm"])
	}
	c.send(t, token)
	if m := c.readFrame(t); m["type"] != "ack" || m["upto"] != 5.0 {
		t.Fatalf("reply = %v, want ack upto 5", m)
	}
	if n := x.h.count(); n != 1 {
		t.Fatalf("frames handled = %d, want 1", n)
	}
}

func TestProtocolUnsupported(t *testing.T) {
	x := newHarness(t)
	x.start(t)
	c := x.hub.next(t)
	c.readFrame(t)
	c.send(t, `{"v":1,"type":"error","code":"protocol_unsupported","message":"agent protocol 1 is not supported","upgrade_hint":"run hookci upgrade"}`)
	c.c.Close(4400, "protocol_unsupported")

	if err := x.runErr(t); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Run = %v, want ErrUnsupported", err)
	}
	if !strings.Contains(x.logs.String(), "run hookci upgrade") {
		t.Fatalf("upgrade hint not logged; logs:\n%s", x.logs.String())
	}
}

func TestAgentTooOld(t *testing.T) {
	x := newHarness(t)
	x.start(t)
	c := x.hub.next(t)
	c.readFrame(t)
	c.drain()
	c.send(t, `{"v":1,"type":"welcome","hub_version":"test","protocol_min":1,"protocol_max":1,"agent_id":"agt_1","installation_id":42,"min_agent_version":"v1.3.0"}`)

	err := x.runErr(t)
	if !errors.Is(err, ErrAgentTooOld) || !strings.Contains(err.Error(), "agent_too_old") {
		t.Fatalf("Run = %v, want ErrAgentTooOld", err)
	}
	if x.client.Connected() {
		t.Fatal("Connected() after agent_too_old")
	}
}

func TestUpgradeAvailableLogged(t *testing.T) {
	x := newHarness(t)
	x.start(t)
	c := x.hub.next(t)
	c.readFrame(t)
	c.send(t, `{"v":1,"type":"welcome","hub_version":"test","protocol_min":1,"protocol_max":1,"agent_id":"agt_1","installation_id":42,"latest_agent_version":"v1.4.0","min_agent_version":"v1.2.3"}`)

	const hint = "upgrade available: 1.2.3 -> v1.4.0"
	waitFor(t, "upgrade hint", func() bool { return strings.Contains(x.logs.String(), hint) })
	if n := strings.Count(x.logs.String(), hint); n != 1 {
		t.Fatalf("hint logged %d times, want 1", n)
	}
}

func TestRevoked(t *testing.T) {
	t.Run("http 401", func(t *testing.T) {
		x := newHarness(t)
		x.hub.refuse.Store(http.StatusUnauthorized)
		x.start(t)
		if err := x.runErr(t); !errors.Is(err, ErrRevoked) {
			t.Fatalf("Run = %v, want ErrRevoked", err)
		}
		x.clk.Advance(time.Minute)
		time.Sleep(20 * time.Millisecond)
		if n := x.hub.requests.Load(); n != 1 {
			t.Fatalf("hub saw %d connect attempts, want 1", n)
		}
	})
	for _, code := range []string{"revoked", "auth_failed"} {
		t.Run("error "+code, func(t *testing.T) {
			x := newHarness(t)
			x.start(t)
			c := x.hub.next(t)
			c.handshake(t)
			waitFor(t, "Connected()", x.client.Connected)
			c.send(t, `{"v":1,"type":"error","code":"`+code+`","message":"agent credential revoked"}`)
			c.c.Close(4401, "revoked")
			if err := x.runErr(t); !errors.Is(err, ErrRevoked) {
				t.Fatalf("Run = %v, want ErrRevoked", err)
			}
			x.clk.Advance(time.Minute)
			time.Sleep(20 * time.Millisecond)
			if n := x.hub.requests.Load(); n != 1 {
				t.Fatalf("hub saw %d connect attempts, want 1", n)
			}
		})
	}
}

// refusalHandler records the token refusals it is told about and reports
// claim for them.
type refusalHandler struct {
	recordingHandler
	claim bool
	asked atomic.Int32
}

func (h *refusalHandler) TokenRefused(runID, _ string) bool {
	if runID == "run_7" {
		h.asked.Add(1)
	}
	return h.claim
}

// TestTokenRefusals: an auth_failed frame with a run_id refuses that one
// token request and keeps the session, even with no request waiting; an
// auth_failed without a run_id, or a revoked frame, ends Run with
// ErrRevoked.
func TestTokenRefusals(t *testing.T) {
	tests := []struct {
		name      string
		code      string
		runID     string
		claim     bool
		wantAsked int32
		wantErr   bool
	}{
		{name: "refusal of a waiting request", code: "auth_failed", runID: "run_7", claim: true, wantAsked: 1},
		{name: "refusal with no request waiting", code: "auth_failed", runID: "run_7", wantAsked: 1},
		{name: "auth_failed without run_id", code: "auth_failed", claim: true, wantErr: true},
		{name: "revoked never asked", code: "revoked", runID: "run_7", claim: true, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			x := newHarness(t)
			h := &refusalHandler{claim: tc.claim}
			x.client = New(x.client.cfg, x.st, h, x.client.log)
			x.start(t)
			c := x.hub.next(t)
			c.handshake(t)
			waitFor(t, "Connected()", x.client.Connected)
			runID := ""
			if tc.runID != "" {
				runID = `"run_id":"` + tc.runID + `",`
			}
			c.send(t, `{"v":1,"type":"error","seq":3,`+runID+`"code":"`+tc.code+`","message":"run not bound"}`)
			if m := c.readFrame(t); m["type"] != "ack" || m["upto"] != 3.0 {
				t.Fatalf("reply = %v, want ack upto 3", m)
			}
			if tc.wantErr {
				c.drain()
				if err := x.runErr(t); !errors.Is(err, ErrRevoked) {
					t.Fatalf("Run = %v, want ErrRevoked", err)
				}
			} else {
				c.send(t, `{"v":1,"type":"token","seq":4,"run_id":"run_1","token":"ghs_x","exp":1700000000}`)
				if m := c.readFrame(t); m["type"] != "ack" || m["upto"] != 4.0 {
					t.Fatalf("reply = %v, want ack upto 4 on the same session", m)
				}
				if n := h.count(); n != 1 {
					t.Fatalf("HandleFrame called %d times, want 1", n)
				}
			}
			if n := h.asked.Load(); n != tc.wantAsked {
				t.Errorf("TokenRefused called %d times, want %d", n, tc.wantAsked)
			}
		})
	}
}

// liveHandler records live tail frames and ended sessions.
type liveHandler struct {
	recordingHandler
	live  chan protocol.Frame
	ended atomic.Int32
}

func (h *liveHandler) HandleLive(f protocol.Frame) { h.live <- f }
func (h *liveHandler) SessionEnded()               { h.ended.Add(1) }

// TestLiveLogTail: log_subscribe and log_unsubscribe reach HandleLive without
// a seq or an ack, SendLog writes on the open session outside the outbox,
// and a closed session ends the live tail.
func TestLiveLogTail(t *testing.T) {
	x := newHarness(t)
	h := &liveHandler{live: make(chan protocol.Frame, 2)}
	x.client = New(x.client.cfg, x.st, h, x.client.log)
	if err := x.client.SendLog(protocol.Log{RunId: "run_1", Job: "build"}); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("SendLog before connecting = %v, want ErrNotConnected", err)
	}
	x.start(t)
	c := x.hub.next(t)
	c.handshake(t)
	waitFor(t, "Connected()", x.client.Connected)

	c.send(t, `{"v":1,"type":"log_subscribe","run_id":"run_1","job":"build","offset":4096}`)
	c.send(t, `{"v":1,"type":"log_unsubscribe","run_id":"run_1","job":"build"}`)
	for _, want := range []protocol.Frame{
		protocol.LogSubscribe{V: 1, Type: "log_subscribe", RunId: "run_1", Job: "build", Offset: 4096},
		protocol.LogUnsubscribe{V: 1, Type: "log_unsubscribe", RunId: "run_1", Job: "build"},
	} {
		select {
		case got := <-h.live:
			if got != want {
				t.Errorf("HandleLive got %+v, want %+v", got, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("HandleLive never got %T", want)
		}
	}

	sent := make(chan error, 1)
	go func() {
		sent <- x.client.SendLog(protocol.Log{RunId: "run_1", Job: "build", Offset: 4096, Bytes: "aGkK", Eof: true})
	}()
	m := c.readFrame(t)
	want := map[string]any{"v": 1.0, "type": "log", "run_id": "run_1", "job": "build", "offset": 4096.0, "bytes": "aGkK", "eof": true}
	if !reflect.DeepEqual(m, want) {
		t.Errorf("hub got %v, want %v (no ack, no seq)", m, want)
	}
	if err := <-sent; err != nil {
		t.Fatalf("SendLog = %v", err)
	}
	if n, err := x.st.Pending(context.Background(), 0, 0); err != nil || len(n) != 0 {
		t.Errorf("outbox = %v, %v; want the log frame never stored", n, err)
	}

	c.c.CloseNow()
	waitFor(t, "SessionEnded", func() bool { return h.ended.Load() == 1 })
	if err := x.client.SendLog(protocol.Log{RunId: "run_1", Job: "build"}); !errors.Is(err, ErrNotConnected) {
		t.Errorf("SendLog after the session ended = %v, want ErrNotConnected", err)
	}
}

func TestPingTimeout(t *testing.T) {
	x := newHarness(t)
	x.start(t)
	c := x.hub.next(t)
	c.handshake(t)
	waitFor(t, "Connected()", x.client.Connected)

	x.clk.Advance(pingInterval)
	if got := string(c.read(t)); got != "ping" {
		t.Fatalf("after 20 s the client sent %q, want ping", got)
	}
	c.drain()
	x.clk.Advance(pingTimeout - pingInterval - time.Second)
	time.Sleep(50 * time.Millisecond)
	if !x.client.Connected() || x.hub.accepted.Load() != 1 {
		t.Fatal("client dropped the session before 45 s of silence")
	}
	x.clk.Advance(time.Second)
	waitFor(t, "disconnect after 45 s", func() bool { return !x.client.Connected() })
	advanceUntil(t, x.clk, "reconnect", func() bool { return x.hub.accepted.Load() >= 2 })
	x.hub.next(t).handshake(t)
	waitFor(t, "Connected() after reconnect", x.client.Connected)
}

func TestConnectURL(t *testing.T) {
	tests := []struct{ in, want, err string }{
		{"https://ci.hookci.com", "wss://ci.hookci.com/v1/agent/connect", ""},
		{"https://ci.hookci.com/", "wss://ci.hookci.com/v1/agent/connect", ""},
		{"http://127.0.0.1:8787", "ws://127.0.0.1:8787/v1/agent/connect", ""},
		{"ftp://ci.hookci.com", "", "scheme must be http or https"},
		{"https://", "", "missing host"},
	}
	for _, tc := range tests {
		got, err := connectURL(tc.in)
		if tc.err != "" {
			if err == nil || !strings.Contains(err.Error(), tc.err) {
				t.Errorf("connectURL(%q) err = %v, want %q", tc.in, err, tc.err)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("connectURL(%q) = %q, %v; want %q", tc.in, got, err, tc.want)
		}
	}
}

func TestSendEventSetsAgentSeq(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	c := New(Config{HubURL: "https://hub.invalid"}, st, nil, nil)
	ctx := context.Background()
	if _, err := c.Send(ctx, protocol.Accepted{TriggerId: "trg_1", RunId: "run_1"}); err != nil {
		t.Fatal(err)
	}
	seq, err := c.Send(ctx, protocol.Event{RunId: "run_1", State: protocol.EventStateRunning})
	if err != nil {
		t.Fatal(err)
	}
	items, err := st.Pending(ctx, 1, 0)
	if err != nil || len(items) != 1 {
		t.Fatalf("Pending = %v, %v", items, err)
	}
	var ev protocol.Event
	if err := protocol.Unmarshal(items[0].Payload, &ev); err != nil {
		t.Fatal(err)
	}
	if int64(ev.AgentSeq) != seq || seq != 2 {
		t.Fatalf("agent_seq = %d, seq = %d; want both 2", ev.AgentSeq, seq)
	}
	if _, err := c.Send(ctx, protocol.Ack{Upto: 1}); err == nil {
		t.Fatal("Send(ack) succeeded, want an error: ack is not an outbox frame")
	}
}

// TestWithdrawDropsFrame: a withdrawn token_request leaves the outbox, so
// the next session does not replay it; other frames stay queued.
func TestWithdrawDropsFrame(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	c := New(Config{HubURL: "https://hub.invalid"}, st, nil, nil)
	ctx := context.Background()
	req, err := c.Send(ctx, protocol.TokenRequest{RunId: "run_1", Purpose: protocol.TokenRequestPurposeFetch})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Send(ctx, protocol.Accepted{TriggerId: "trg_1", RunId: "run_1"}); err != nil {
		t.Fatal(err)
	}
	if err := c.Withdraw(ctx, req); err != nil {
		t.Fatal(err)
	}
	items, err := st.Pending(ctx, 0, 0)
	if err != nil || len(items) != 1 || items[0].Kind != "accepted" {
		t.Fatalf("Pending after Withdraw = %+v, %v; want only the accepted frame", items, err)
	}
}
