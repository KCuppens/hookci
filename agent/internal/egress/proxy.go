package egress

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxHeaderBytes       = 8 << 10
	defaultHeaderTimeout = 10 * time.Second
	defaultIdleTimeout   = 5 * time.Minute
	defaultMaxConns      = 256
	// upstreamTimeout bounds resolving plus dialing one CONNECT target.
	upstreamTimeout = 10 * time.Second
)

// Decision reasons.
const (
	reasonAllowed        = "allowed"
	reasonNotAllowlisted = "not-allowlisted"
	reasonIPLiteral      = "ip-literal"
	reasonBadPort        = "bad-port"
	reasonForbiddenIP    = "forbidden-ip"
	reasonDNSError       = "dns-error"
	reasonDialError      = "dial-error"
	reasonMethod         = "method-not-allowed"
	reasonBadRequest     = "bad-request"
	reasonTooManyConns   = "too-many-connections"
)

// DialFunc opens the upstream connection to a vetted "ip:443" address.
type DialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// Decision is the outcome of one proxy connection.
type Decision struct {
	Host    string
	Port    int
	Allowed bool
	Reason  string // "allowed", "not-allowlisted", "ip-literal", "bad-port", "forbidden-ip", "dns-error", "dial-error", "method-not-allowed", "bad-request", "too-many-connections"
	IP      net.IP // the vetted IP that was dialed, nil if none
}

// Options configures a Proxy.
type Options struct {
	RunID         string
	Allow         *AllowList
	Resolver      Resolver       // default NetResolver{}
	Dial          DialFunc       // default (&net.Dialer{Timeout: 10 * time.Second}).DialContext
	OnDecision    func(Decision) // optional; executor writes these to the run log
	HeaderTimeout time.Duration  // default 10s
	IdleTimeout   time.Duration  // default 5m of no bytes in either direction
	MaxConns      int            // default 256 concurrent tunnels
}

// Stats counts decisions and the tunnels currently open.
type Stats struct{ Allowed, Denied, Active int64 }

// Proxy is one run's CONNECT proxy.
type Proxy struct {
	opts   Options
	ln     net.Listener
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	closeOnce sync.Once
	closeErr  error

	mu     sync.Mutex
	closed bool
	conns  map[net.Conn]struct{}

	allowed, denied, active atomic.Int64
}

// Start listens on 127.0.0.1:0 and serves until Close or ctx is done.
func Start(ctx context.Context, opts Options) (*Proxy, error) {
	if opts.Allow == nil {
		return nil, errors.New("egress: Options.Allow is required")
	}
	if opts.Resolver == nil {
		opts.Resolver = NetResolver{}
	}
	if opts.Dial == nil {
		opts.Dial = (&net.Dialer{Timeout: 10 * time.Second}).DialContext
	}
	if opts.HeaderTimeout <= 0 {
		opts.HeaderTimeout = defaultHeaderTimeout
	}
	if opts.IdleTimeout <= 0 {
		opts.IdleTimeout = defaultIdleTimeout
	}
	if opts.MaxConns <= 0 {
		opts.MaxConns = defaultMaxConns
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("egress: run %s: listen: %w", opts.RunID, err)
	}
	pctx, cancel := context.WithCancel(ctx)
	p := &Proxy{opts: opts, ln: ln, ctx: pctx, cancel: cancel, conns: make(map[net.Conn]struct{})}
	p.wg.Add(1)
	go p.acceptLoop()
	go func() {
		<-pctx.Done()
		_ = p.Close()
	}()
	return p, nil
}

// Addr returns "127.0.0.1:<port>".
func (p *Proxy) Addr() string { return p.ln.Addr().String() }

// Port returns the listening port.
func (p *Proxy) Port() int { return p.ln.Addr().(*net.TCPAddr).Port }

// Stats returns the decision counters and the number of active tunnels.
func (p *Proxy) Stats() Stats {
	return Stats{Allowed: p.allowed.Load(), Denied: p.denied.Load(), Active: p.active.Load()}
}

// Close stops accepting, closes all open tunnels, and waits for goroutines.
func (p *Proxy) Close() error {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.closed = true
		for c := range p.conns {
			_ = c.Close()
		}
		p.mu.Unlock()
		p.cancel()
		if err := p.ln.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			p.closeErr = err
		}
	})
	p.wg.Wait()
	return p.closeErr
}

func (p *Proxy) acceptLoop() {
	defer p.wg.Done()
	for {
		conn, err := p.ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			select {
			case <-p.ctx.Done():
				return
			case <-time.After(10 * time.Millisecond):
			}
			continue
		}
		if !p.track(conn) {
			continue
		}
		p.wg.Add(1)
		go p.handle(conn)
	}
}

// track registers c so Close can close it. After Close it closes c and
// returns false.
func (p *Proxy) track(c net.Conn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		_ = c.Close()
		return false
	}
	p.conns[c] = struct{}{}
	return true
}

func (p *Proxy) untrack(c net.Conn) {
	p.mu.Lock()
	delete(p.conns, c)
	p.mu.Unlock()
	_ = c.Close()
}

// acquire reserves one of MaxConns tunnel slots.
func (p *Proxy) acquire() bool {
	for {
		n := p.active.Load()
		if n >= int64(p.opts.MaxConns) {
			return false
		}
		if p.active.CompareAndSwap(n, n+1) {
			return true
		}
	}
}

func (p *Proxy) handle(client net.Conn) {
	defer p.wg.Done()
	defer p.untrack(client)

	_ = client.SetReadDeadline(time.Now().Add(p.opts.HeaderTimeout))
	br := bufio.NewReaderSize(&io.LimitedReader{R: client, N: maxHeaderBytes}, maxHeaderBytes)
	req, err := http.ReadRequest(br)
	if err != nil {
		p.deny(client, Decision{Reason: reasonBadRequest}, http.StatusBadRequest, "zeroci egress: bad request")
		return
	}
	if req.Method != http.MethodConnect {
		p.deny(client, Decision{Host: req.URL.Hostname(), Reason: reasonMethod},
			http.StatusMethodNotAllowed, "zeroci egress: only CONNECT is allowed")
		return
	}
	d, status, body := checkTarget(p.opts.Allow, req.URL.Host)
	if status != 0 {
		p.deny(client, d, status, body)
		return
	}
	if !p.acquire() {
		d.Reason = reasonTooManyConns
		p.deny(client, d, http.StatusServiceUnavailable, "zeroci egress: too many connections")
		return
	}
	defer p.active.Add(-1)

	ctx, cancel := context.WithTimeout(p.ctx, upstreamTimeout)
	upstream, ip, reason := p.connect(ctx, d.Host)
	cancel()
	if upstream != nil && !p.track(upstream) {
		upstream, ip, reason = nil, nil, reasonDialError
	}
	switch reason {
	case reasonDNSError:
		d.Reason = reason
		p.deny(client, d, http.StatusBadGateway, "zeroci egress: cannot resolve "+d.Host)
		return
	case reasonForbiddenIP:
		d.Reason = reason
		p.deny(client, d, http.StatusForbidden, "zeroci egress: "+d.Host+" resolves to a forbidden address")
		return
	case reasonDialError:
		d.Reason = reason
		p.deny(client, d, http.StatusBadGateway, "zeroci egress: cannot connect to "+d.Host)
		return
	}
	defer p.untrack(upstream)

	d.Allowed, d.Reason, d.IP = true, reasonAllowed, ip
	p.emit(d)

	idle := newIdleTimer(p.opts.IdleTimeout)
	c := &deadlineConn{Conn: client, t: idle}
	u := &deadlineConn{Conn: upstream, t: idle}
	if _, err := io.WriteString(c, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	buffered, _ := br.Peek(br.Buffered())
	tunnel(c, u, buffered)
}

// checkTarget validates a CONNECT authority. status is 0 when the target may
// be resolved and dialed.
func checkTarget(allow *AllowList, authority string) (Decision, int, string) {
	rawHost, rawPort, err := net.SplitHostPort(authority)
	if err != nil {
		return Decision{Host: authority, Reason: reasonBadRequest}, http.StatusBadRequest, "zeroci egress: bad request"
	}
	d := Decision{Host: rawHost}
	d.Port, _ = strconv.Atoi(rawPort)
	if isIPLiteral(rawHost) {
		d.Reason = reasonIPLiteral
		return d, http.StatusForbidden, "zeroci egress: IP literal targets are not allowed; use a host name"
	}
	if rawPort != "443" {
		d.Reason = reasonBadPort
		return d, http.StatusForbidden, "zeroci egress: only port 443 is allowed"
	}
	host, err := NormalizeHost(rawHost)
	if err != nil {
		d.Reason = reasonBadRequest
		return d, http.StatusBadRequest, "zeroci egress: bad request"
	}
	d.Host = host
	if isIPLiteral(host) {
		d.Reason = reasonIPLiteral
		return d, http.StatusForbidden, "zeroci egress: IP literal targets are not allowed; use a host name"
	}
	if !allow.Allows(host) {
		d.Reason = reasonNotAllowlisted
		return d, http.StatusForbidden, "zeroci egress: " + host +
			" is not in the allow-list; add it under checks.egress in .zeroci.yml (trusted runs only)"
	}
	return d, 0, ""
}

// connect resolves host, refuses the whole answer if any address is
// forbidden, then dials the vetted addresses in order. Each attempt gets an
// equal share of the time left so one unresponsive address cannot starve the
// rest. On failure it returns the decision reason.
func (p *Proxy) connect(ctx context.Context, host string) (net.Conn, net.IP, string) {
	addrs, err := p.opts.Resolver.LookupIPAddr(ctx, host)
	if err != nil || len(addrs) == 0 {
		return nil, nil, reasonDNSError
	}
	for _, a := range addrs {
		if IsForbiddenIP(a.IP) {
			return nil, nil, reasonForbiddenIP
		}
	}
	deadline, _ := ctx.Deadline()
	for i, a := range addrs {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		tryCtx, cancel := context.WithTimeout(ctx, remaining/time.Duration(len(addrs)-i))
		conn, err := p.opts.Dial(tryCtx, "tcp", net.JoinHostPort(a.IP.String(), "443"))
		cancel()
		if err == nil {
			return conn, a.IP, ""
		}
	}
	return nil, nil, reasonDialError
}

func (p *Proxy) emit(d Decision) {
	if d.Allowed {
		p.allowed.Add(1)
	} else {
		p.denied.Add(1)
	}
	if p.opts.OnDecision != nil {
		p.opts.OnDecision(d)
	}
}

// deny records d and writes a plain-text error response. The caller closes c.
func (p *Proxy) deny(c net.Conn, d Decision, status int, body string) {
	p.emit(d)
	body += "\n"
	_ = c.SetWriteDeadline(time.Now().Add(p.opts.HeaderTimeout))
	_, _ = fmt.Fprintf(c, "HTTP/1.1 %d %s\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
		status, http.StatusText(status), len(body), body)
}

// tunnel forwards buffered (client bytes read past the CONNECT header) to
// upstream, then copies both ways until both directions finish.
func tunnel(client, upstream *deadlineConn, buffered []byte) {
	if len(buffered) > 0 {
		if _, err := upstream.Write(buffered); err != nil {
			return
		}
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		pipe(upstream, client)
	}()
	go func() {
		defer wg.Done()
		pipe(client, upstream)
	}()
	wg.Wait()
}

// pipe copies src to dst. On EOF it half-closes dst so TLS close_notify and
// the peer's remaining data still flow; on error it closes both sides so the
// other direction stops too.
func pipe(dst, src *deadlineConn) {
	if _, err := io.Copy(dst, src); err != nil {
		_ = src.Close()
		_ = dst.Close()
		return
	}
	if cw, ok := dst.Conn.(interface{ CloseWrite() error }); ok {
		_ = cw.CloseWrite()
		return
	}
	_ = dst.Close()
}

// idleTimer records the last time bytes moved in either direction of one
// tunnel.
type idleTimer struct {
	idle time.Duration
	last atomic.Int64 // unix nanoseconds
}

func newIdleTimer(idle time.Duration) *idleTimer {
	t := &idleTimer{idle: idle}
	t.touch()
	return t
}

func (t *idleTimer) touch() { t.last.Store(time.Now().UnixNano()) }

func (t *idleTimer) deadline() time.Time { return time.Unix(0, t.last.Load()).Add(t.idle) }

// deadlineConn closes a tunnel after idle with no bytes in either direction.
// A Read that times out while the other direction is still moving bytes is
// re-armed against the shared idleTimer instead of failing.
type deadlineConn struct {
	net.Conn
	t *idleTimer
}

func (d *deadlineConn) Read(b []byte) (int, error) {
	for {
		_ = d.Conn.SetReadDeadline(d.t.deadline())
		n, err := d.Conn.Read(b)
		if n > 0 {
			d.t.touch()
		}
		var ne net.Error
		if n == 0 && errors.As(err, &ne) && ne.Timeout() && time.Now().Before(d.t.deadline()) {
			continue
		}
		return n, err
	}
}

func (d *deadlineConn) Write(b []byte) (int, error) {
	_ = d.Conn.SetWriteDeadline(time.Now().Add(d.t.idle))
	n, err := d.Conn.Write(b)
	if n > 0 {
		d.t.touch()
	}
	return n, err
}
