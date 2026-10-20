// Package hubclient is the agent end of the hub protocol: a reconnecting
// WebSocket session that says hello, keeps the link alive with pings, replays
// the durable outbox and acknowledges hub frames exactly once.
package hubclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/clock"
	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
	"github.com/KCuppens/zerocideploy/agent/internal/store"
	"github.com/KCuppens/zerocideploy/agent/internal/version"
)

// Session timings.
const (
	welcomeTimeout = 10 * time.Second
	pingInterval   = 20 * time.Second
	pingTimeout    = 45 * time.Second
	writeTimeout   = 10 * time.Second
	// rateLimitedWait is the shortest wait after the hub reports rate_limited.
	rateLimitedWait = 30 * time.Second
	// flushBatch bounds how many outbox rows one Pending call loads.
	flushBatch = 100
)

// WebSocket close codes the client sends.
const (
	closeNormal    = 1000
	closeGoingAway = 1001
)

// ErrRevoked means the hub refused the agent credential. Reconnecting cannot
// help: the agent must be paired again.
var ErrRevoked = errors.New("hubclient: agent credential revoked")

// ErrUnsupported means the hub does not speak this agent's protocol version.
var ErrUnsupported = errors.New("hubclient: protocol unsupported by hub")

// ErrAgentTooOld means the agent is older than the welcome's
// min_agent_version. Reconnecting cannot fix it; upgrading can.
var ErrAgentTooOld = errors.New("hubclient: agent_too_old")

// errRateLimited makes Run wait at least rateLimitedWait before reconnecting.
var errRateLimited = errors.New("hubclient: rate limited by hub")

// Config configures a Client.
type Config struct {
	HubURL     string // e.g. https://ci.webuno.io
	AgentID    string
	Credential string // zc_agent_...
	Version    string
	Protocol   int         // 0 = protocol.Version
	Dialer     Dialer      // nil = real websocket dialer
	Clock      clock.Clock // nil = real clock
}

// Handler receives the hub frames that carry a seq: trigger, token,
// interrupt and log_subscribe. HandleFrame runs on the session goroutine, so
// it must return promptly and hand long work to another goroutine. A frame
// HandleFrame fails is not acknowledged: the session drops and the hub
// resends it after the reconnect. HandleFrame must be idempotent, since a
// crash between handling and acknowledging also brings the frame back.
type Handler interface {
	HandleFrame(ctx context.Context, f protocol.Frame) error
}

// TokenRefusals is implemented by a Handler with token requests the hub may
// refuse without the agent credential being at fault. The hub answers such a
// refusal with an auth_failed error frame that names no request.
type TokenRefusals interface {
	// TokenRefused reports whether e is charged to one of the handler's
	// pending requests; then the session goes on instead of ending with
	// ErrRevoked.
	TokenRefused(e protocol.Error) bool
}

// Client is a reconnecting hub session.
type Client struct {
	cfg       Config
	st        *store.Store
	h         Handler
	log       *slog.Logger
	dialer    Dialer
	clk       clock.Clock
	backoff   Backoff
	connected atomic.Bool
	flush     chan struct{}
}

// New returns a client that persists outbound frames and the inbound
// high-water mark in st. A client with a nil st can only Handshake. A nil
// log discards log output.
func New(cfg Config, st *store.Store, h Handler, log *slog.Logger) *Client {
	if cfg.Protocol == 0 {
		cfg.Protocol = protocol.Version
	}
	c := &Client{cfg: cfg, st: st, h: h, log: log, dialer: cfg.Dialer, clk: cfg.Clock, flush: make(chan struct{}, 1)}
	if c.log == nil {
		c.log = slog.New(slog.DiscardHandler)
	}
	if c.dialer == nil {
		c.dialer = WebSocketDialer{}
	}
	if c.clk == nil {
		c.clk = clock.Real{}
	}
	return c
}

// Connected reports whether a session is open and welcomed.
func (c *Client) Connected() bool { return c.connected.Load() }

// Flush wakes the session to send outbox rows appended outside Send. It
// never blocks; without a session the rows go out after the next welcome.
func (c *Client) Flush() {
	select {
	case c.flush <- struct{}{}:
	default:
	}
}

// Send appends f to the outbox and flushes it. The returned seq is the
// frame's outbox seq, which is also the agent_seq of event and annotations
// frames. f must be an agent frame value: Accepted, Rejected, JobPlanned,
// Event, Annotations, TokenRequest or Log.
func (c *Client) Send(ctx context.Context, f protocol.Frame) (seq int64, err error) {
	switch m := f.(type) {
	case protocol.Event:
		seq, err = c.st.AppendSeqFrame(ctx, store.KindEvent, func(s int) any { m.AgentSeq = s; return m })
	case protocol.Annotations:
		seq, err = c.st.AppendSeqFrame(ctx, store.KindAnnotations, func(s int) any { m.AgentSeq = s; return m })
	default:
		kind, ok := sendKind(f)
		if !ok {
			return 0, fmt.Errorf("hubclient: send: %T is not an agent frame", f)
		}
		payload, merr := protocol.Marshal(kind, f)
		if merr != nil {
			return 0, fmt.Errorf("hubclient: send %s: %w", kind, merr)
		}
		seq, err = c.st.AppendOutbox(ctx, kind, payload)
	}
	if err != nil {
		return 0, fmt.Errorf("hubclient: send: %w", err)
	}
	c.Flush()
	return seq, nil
}

func sendKind(f protocol.Frame) (string, bool) {
	switch f.(type) {
	case protocol.Accepted:
		return "accepted", true
	case protocol.Rejected:
		return "rejected", true
	case protocol.JobPlanned:
		return store.KindJobPlanned, true
	case protocol.TokenRequest:
		return "token_request", true
	case protocol.Log:
		return "log", true
	}
	return "", false
}

// Run keeps a session open until ctx ends or the hub refuses the agent for
// good. It returns ErrRevoked, ErrUnsupported, ErrAgentTooOld or ctx.Err().
func (c *Client) Run(ctx context.Context) error {
	if c.h == nil || c.st == nil {
		return errors.New("hubclient: run: nil handler or store")
	}
	for {
		connectedFor, err := c.session(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, ErrRevoked) || errors.Is(err, ErrUnsupported) || errors.Is(err, ErrAgentTooOld) {
			return err
		}
		c.backoff.Disconnected(connectedFor)
		wait := c.backoff.Next()
		if errors.Is(err, errRateLimited) {
			wait = max(wait, rateLimitedWait)
		}
		c.log.Warn("hub connection lost", "err", err, "retry_in", wait)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.clk.After(wait):
		}
	}
}

// Handshake dials the hub, completes one hello/welcome exchange and closes
// the connection without handling or acknowledging any hub frame. Without a
// store the hello claims no hub frame, as a newly paired agent has seen none.
func (c *Client) Handshake(ctx context.Context) (protocol.Welcome, error) {
	s, err := c.open(ctx)
	if err != nil {
		return protocol.Welcome{}, err
	}
	s.close(closeNormal, "handshake done")
	return s.welcome, nil
}

// session runs one connection until it fails and reports how long it stayed
// welcomed.
func (c *Client) session(ctx context.Context) (time.Duration, error) {
	s, err := c.open(ctx)
	if err != nil {
		return 0, err
	}
	start := c.clk.Now()
	ping := c.clk.NewTicker(pingInterval)
	defer ping.Stop()
	idle := c.clk.After(pingTimeout)
	c.connected.Store(true)
	c.log.Info("connected to hub", "hub", c.cfg.HubURL, "agent_id", s.welcome.AgentId, "hub_version", s.welcome.HubVersion)
	if latest := deref(s.welcome.LatestAgentVersion); latest != "" && version.Compare(c.cfg.Version, latest) < 0 {
		c.log.Warn(fmt.Sprintf("upgrade available: %s -> %s", c.cfg.Version, latest), "hint", "run zeroci upgrade")
	}

	err = c.loop(ctx, s, ping, idle)
	c.connected.Store(false)
	code, reason := closeGoingAway, "reconnecting"
	if ctx.Err() != nil {
		code, reason = closeNormal, "shutdown"
	}
	s.close(code, reason)
	return c.clk.Now().Sub(start), err
}

func (c *Client) loop(ctx context.Context, s *conn, ping clock.Ticker, idle <-chan time.Time) error {
	var sent int64
	if err := c.flushOutbox(ctx, s, &sent); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case m := <-s.in:
			if m.err != nil {
				return m.err
			}
			idle = c.clk.After(pingTimeout)
			if err := c.handle(ctx, s, m.b); err != nil {
				return err
			}
		case <-c.flush:
			if err := c.flushOutbox(ctx, s, &sent); err != nil {
				return err
			}
		case <-ping.C():
			if err := s.write(ctx, []byte("ping")); err != nil {
				return err
			}
		case <-idle:
			return fmt.Errorf("hubclient: no traffic from hub for %s", pingTimeout)
		}
	}
}

// flushOutbox sends every pending outbox row above *sent in seq order.
func (c *Client) flushOutbox(ctx context.Context, s *conn, sent *int64) error {
	for {
		items, err := c.st.Pending(ctx, *sent, flushBatch)
		if err != nil {
			return fmt.Errorf("hubclient: flush: %w", err)
		}
		for _, it := range items {
			frame, err := withSeq(it.Payload, it.Seq)
			if err != nil {
				return fmt.Errorf("hubclient: flush %s seq %d: %w", it.Kind, it.Seq, err)
			}
			if err := s.write(ctx, frame); err != nil {
				return err
			}
			*sent = it.Seq
		}
		if len(items) < flushBatch {
			return nil
		}
	}
}

// withSeq adds the outbox seq to a stored frame.
func withSeq(payload []byte, seq int64) ([]byte, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(payload, &m); err != nil {
		return nil, err
	}
	m["seq"] = json.RawMessage(strconv.FormatInt(seq, 10))
	return json.Marshal(m)
}

// handle processes one hub message after welcome.
func (c *Client) handle(ctx context.Context, s *conn, b []byte) error {
	if string(b) == "pong" {
		return nil
	}
	f, err := protocol.DecodeFrame(b)
	if err != nil {
		c.log.Warn("ignoring invalid hub frame", "err", err)
		return nil
	}
	switch v := f.(type) {
	case protocol.Ack:
		if err := c.st.Ack(ctx, int64(v.Upto)); err != nil {
			return fmt.Errorf("hubclient: ack: %w", err)
		}
		return nil
	case protocol.Welcome:
		return nil
	}
	seq, ok := inboundSeq(f)
	if !ok {
		if e, isErr := f.(protocol.Error); isErr {
			return c.hubError(e)
		}
		c.log.Warn("ignoring hub frame without seq", "type", fmt.Sprintf("%T", f))
		return nil
	}
	hwm, err := c.st.GetHWM(ctx, store.HWMIn)
	if err != nil {
		return fmt.Errorf("hubclient: inbound: %w", err)
	}
	if seq <= hwm {
		return s.ack(ctx, hwm)
	}
	var after error
	if e, isErr := f.(protocol.Error); isErr {
		after = c.hubError(e)
	} else if err := c.h.HandleFrame(ctx, f); err != nil {
		return fmt.Errorf("hubclient: handle hub frame seq %d: %w", seq, err)
	}
	if err := c.st.SetHWM(ctx, store.HWMIn, seq); err != nil {
		return fmt.Errorf("hubclient: inbound: %w", err)
	}
	if err := s.ack(ctx, seq); err != nil {
		return err
	}
	return after
}

// inboundSeq returns the hub outbox seq a frame carries.
func inboundSeq(f protocol.Frame) (int64, bool) {
	var p *int
	switch v := f.(type) {
	case protocol.Trigger:
		p = v.Seq
	case protocol.Token:
		p = v.Seq
	case protocol.Interrupt:
		p = v.Seq
	case protocol.LogSubscribe:
		p = v.Seq
	case protocol.Error:
		p = v.Seq
	}
	if p == nil {
		return 0, false
	}
	return int64(*p), true
}

// hubError maps an error frame to the session outcome; nil keeps the session.
func (c *Client) hubError(e protocol.Error) error {
	switch e.Code {
	case protocol.ErrorCodeProtocolUnsupported:
		hint := ""
		if e.UpgradeHint != nil {
			hint = *e.UpgradeHint
		}
		c.log.Error("hub does not support this agent's protocol", "message", e.Message, "upgrade_hint", hint)
		return ErrUnsupported
	case protocol.ErrorCodeAuthFailed, protocol.ErrorCodeRevoked:
		if r, ok := c.h.(TokenRefusals); ok && e.Code == protocol.ErrorCodeAuthFailed && r.TokenRefused(e) {
			c.log.Warn("hub refused a token request", "message", e.Message)
			return nil
		}
		c.log.Error("hub refused the agent credential", "code", string(e.Code), "message", e.Message)
		return ErrRevoked
	case protocol.ErrorCodeRateLimited:
		return errRateLimited
	default:
		c.log.Warn("hub reported an error", "code", string(e.Code), "message", e.Message)
		return nil
	}
}

// open dials the hub, sends hello and waits for welcome.
func (c *Client) open(ctx context.Context) (*conn, error) {
	u, err := connectURL(c.cfg.HubURL)
	if err != nil {
		return nil, err
	}
	h := http.Header{}
	h.Set("Authorization", "Bearer "+c.cfg.Credential)
	h.Set("User-Agent", "zeroci-agent/"+c.cfg.Version)
	wc, err := c.dialer.Dial(ctx, u, h)
	if err != nil {
		var se *StatusError
		if errors.As(err, &se) && se.StatusCode == http.StatusUnauthorized {
			return nil, fmt.Errorf("%w: %v", ErrRevoked, err)
		}
		return nil, err
	}
	s := newConn(ctx, wc)

	in := 0
	if c.st != nil {
		hwm, err := c.st.GetHWM(ctx, store.HWMIn)
		if err != nil {
			s.close(closeGoingAway, "store error")
			return nil, fmt.Errorf("hubclient: hello: %w", err)
		}
		in = int(hwm)
	}
	hello := protocol.Hello{AgentVersion: c.cfg.Version, ProtocolVersion: c.cfg.Protocol, InboundHwm: &in}
	if c.cfg.AgentID != "" {
		hello.AgentId = &c.cfg.AgentID
	}
	b, err := protocol.Marshal("hello", hello)
	if err != nil {
		s.close(closeGoingAway, "internal error")
		return nil, fmt.Errorf("hubclient: hello: %w", err)
	}
	if err := s.write(ctx, b); err != nil {
		s.close(closeGoingAway, "write failed")
		return nil, err
	}

	timeout := c.clk.After(welcomeTimeout)
	for {
		select {
		case <-ctx.Done():
			s.close(closeNormal, "shutdown")
			return nil, ctx.Err()
		case <-timeout:
			s.close(closeGoingAway, "welcome timeout")
			return nil, fmt.Errorf("hubclient: no welcome within %s", welcomeTimeout)
		case m := <-s.in:
			if m.err != nil {
				s.close(closeGoingAway, "read failed")
				return nil, m.err
			}
			if string(m.b) == "pong" {
				continue
			}
			f, err := protocol.DecodeFrame(m.b)
			if err != nil {
				c.log.Warn("ignoring invalid hub frame", "err", err)
				continue
			}
			switch v := f.(type) {
			case protocol.Welcome:
				if min := deref(v.MinAgentVersion); min != "" && version.Compare(c.cfg.Version, min) < 0 {
					s.close(closeNormal, "agent too old")
					return nil, fmt.Errorf("%w: agent %s is older than the hub minimum %s; run zeroci upgrade", ErrAgentTooOld, c.cfg.Version, min)
				}
				s.welcome = v
				return s, nil
			case protocol.Error:
				if err := c.hubError(v); err != nil {
					s.close(closeNormal, "hub error")
					return nil, err
				}
			default:
				c.log.Warn("ignoring hub frame before welcome", "type", fmt.Sprintf("%T", f))
			}
		}
	}
}

// connectURL turns the hub base URL into its agent WebSocket endpoint.
func connectURL(hub string) (string, error) {
	u, err := url.Parse(hub)
	if err != nil {
		return "", fmt.Errorf("hubclient: hub url: %w", err)
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("hubclient: hub url %q: scheme must be http or https", hub)
	}
	if u.Host == "" {
		return "", fmt.Errorf("hubclient: hub url %q: missing host", hub)
	}
	u.Path, u.RawPath, u.RawQuery, u.Fragment, u.User = "/v1/agent/connect", "", "", "", nil
	return u.String(), nil
}

// conn is one open connection with its reader goroutine.
type conn struct {
	c       Conn
	in      chan inbound
	done    chan struct{}
	cancel  context.CancelFunc
	welcome protocol.Welcome
}

type inbound struct {
	b   []byte
	err error
}

func newConn(ctx context.Context, c Conn) *conn {
	rctx, cancel := context.WithCancel(ctx)
	s := &conn{c: c, in: make(chan inbound), done: make(chan struct{}), cancel: cancel}
	go func() {
		for {
			b, err := c.Read(rctx)
			select {
			case s.in <- inbound{b, err}:
			case <-s.done:
				return
			}
			if err != nil {
				return
			}
		}
	}()
	return s
}

func (s *conn) write(ctx context.Context, b []byte) error {
	wctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return s.c.Write(wctx, b)
}

func (s *conn) ack(ctx context.Context, upto int64) error {
	b, err := protocol.Marshal("ack", protocol.Ack{Upto: int(upto)})
	if err != nil {
		return fmt.Errorf("hubclient: ack: %w", err)
	}
	return s.write(ctx, b)
}

// close stops the reader and closes the connection. Close errors are moot:
// the connection is gone either way.
func (s *conn) close(code int, reason string) {
	close(s.done)
	_ = s.c.Close(code, reason)
	s.cancel()
}

// deref is *p, or "" when p is nil.
func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
