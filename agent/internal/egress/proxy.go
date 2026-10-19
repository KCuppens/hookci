package egress

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

type contextKey string

const dialTargetKey contextKey = "dialTarget"

const defaultUpstreamTimeout = 10 * time.Second

// dialTarget carries the verified upstream addresses and the request deadline to the transport dialer.
type dialTarget struct {
	addrs    []string
	deadline time.Time
}

var errNoVerifiedAddr = errors.New("egress: no verified upstream address in request context")

// IPResolver resolves a hostname to IP addresses. *net.Resolver satisfies it.
type IPResolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

// Server is a per-run HTTP CONNECT proxy enforcing strict egress domain allowlists
// and anti-SSRF IP blocking.
type Server struct {
	Policy      *Policy
	Resolver    IPResolver
	DialContext func(ctx context.Context, network, addr string) (net.Conn, error)

	listener        net.Listener
	server          *http.Server
	transport       *http.Transport
	upstreamTimeout time.Duration
	mu              sync.Mutex
}

// NewServer constructs an egress proxy Server.
func NewServer(policy *Policy, resolver IPResolver) *Server {
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	s := &Server{
		Policy:          policy,
		Resolver:        resolver,
		upstreamTimeout: defaultUpstreamTimeout,
	}
	s.server = &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
	}
	s.transport = &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			target, ok := ctx.Value(dialTargetKey).(dialTarget)
			if !ok || len(target.addrs) == 0 {
				return nil, errNoVerifiedAddr
			}
			return s.dialFirstReachable(ctx, network, target)
		},
		DisableKeepAlives:   true,
		TLSHandshakeTimeout: 10 * time.Second,
	}
	return s
}

func (s *Server) dialFunc() func(ctx context.Context, network, addr string) (net.Conn, error) {
	if s.DialContext != nil {
		return s.DialContext
	}
	return (&net.Dialer{Timeout: s.upstreamTimeout}).DialContext
}

// dialFirstReachable tries each address in order. Each try gets an equal share of the
// time left before target.deadline, so one unresponsive IP cannot starve the rest.
func (s *Server) dialFirstReachable(ctx context.Context, network string, target dialTarget) (net.Conn, error) {
	dial := s.dialFunc()
	lastErr := error(context.DeadlineExceeded)
	for i, addr := range target.addrs {
		remaining := time.Until(target.deadline)
		if remaining <= 0 {
			break
		}
		tryCtx, cancel := context.WithTimeout(ctx, remaining/time.Duration(len(target.addrs)-i))
		conn, err := dial(tryCtx, network, addr)
		cancel()
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// Start begins listening on the specified host:port (e.g. "127.0.0.1:0" or "127.0.0.1:3128").
func (s *Server) Start(addr string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if addr == "" {
		addr = "127.0.0.1:0"
	}

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", addr, err)
	}
	s.listener = ln

	go func() {
		_ = s.server.Serve(ln)
	}()

	return nil
}

// Addr returns the listener address string (e.g. "127.0.0.1:41235").
func (s *Server) Addr() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener == nil {
		return ""
	}
	return s.listener.Addr().String()
}

// Port returns the bound port number.
func (s *Server) Port() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener == nil {
		return 0
	}
	if tcpAddr, ok := s.listener.Addr().(*net.TCPAddr); ok {
		return tcpAddr.Port
	}
	return 0
}

// Close shuts down the proxy listener.
func (s *Server) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.server != nil {
		return s.server.Close()
	}
	return nil
}

// ServeHTTP handles incoming HTTP CONNECT and forward proxy requests.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		s.handleConnect(w, r)
		return
	}

	s.handleHTTP(w, r)
}

func (s *Server) handleConnect(w http.ResponseWriter, r *http.Request) {
	targetHost := r.Host
	if targetHost == "" {
		targetHost = r.URL.Host
	}

	host, port, err := net.SplitHostPort(targetHost)
	if err != nil {
		host = targetHost
		port = "443"
	}

	// 1. Check hostname against egress policy
	if !s.Policy.IsAllowedHost(host) {
		http.Error(w, "forbidden: host not in egress allowlist", http.StatusForbidden)
		return
	}

	// 2. Resolve DNS directly and verify all resolved IPs
	ctx, cancel := context.WithTimeout(r.Context(), s.upstreamTimeout)
	defer cancel()

	ips, err := s.Resolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		http.Error(w, "bad gateway: host resolution failed", http.StatusBadGateway)
		return
	}

	var allowedIP net.IP
	for _, ipAddr := range ips {
		if IsDisallowedIP(ipAddr.IP) {
			http.Error(w, "forbidden: resolved IP disallowed by egress policy", http.StatusForbidden)
			return
		}
		if allowedIP == nil {
			allowedIP = ipAddr.IP
		}
	}

	// 3. Connect upstream
	targetAddr := net.JoinHostPort(allowedIP.String(), port)
	upstreamConn, err := s.dialFunc()(ctx, "tcp", targetAddr)
	if err != nil {
		http.Error(w, fmt.Sprintf("bad gateway: dial upstream failed: %v", err), http.StatusBadGateway)
		return
	}
	defer upstreamConn.Close()

	// 4. Hijack client connection
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "internal error: hijacking not supported", http.StatusInternalServerError)
		return
	}

	clientConn, _, err := hijacker.Hijack()
	if err != nil {
		http.Error(w, fmt.Sprintf("internal error: hijack failed: %v", err), http.StatusInternalServerError)
		return
	}
	defer clientConn.Close()

	// 5. Send 200 Connection Established
	_, err = clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
	if err != nil {
		return
	}

	// 6. Splice traffic bidirectionally
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		_, _ = io.Copy(upstreamConn, clientConn)
		if tcpConn, ok := upstreamConn.(*net.TCPConn); ok {
			_ = tcpConn.CloseWrite()
		}
	}()

	go func() {
		defer wg.Done()
		_, _ = io.Copy(clientConn, upstreamConn)
		if tcpConn, ok := clientConn.(*net.TCPConn); ok {
			_ = tcpConn.CloseWrite()
		}
	}()

	wg.Wait()
}

func (s *Server) handleHTTP(w http.ResponseWriter, r *http.Request) {
	host := r.URL.Hostname()
	if host == "" {
		host = r.Host
	}

	if !s.Policy.IsAllowedHost(host) {
		http.Error(w, "forbidden: host not in egress allowlist", http.StatusForbidden)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.upstreamTimeout)
	defer cancel()

	ips, err := s.Resolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		http.Error(w, "bad gateway: host resolution failed", http.StatusBadGateway)
		return
	}

	for _, ipAddr := range ips {
		if IsDisallowedIP(ipAddr.IP) {
			http.Error(w, "forbidden: resolved IP disallowed by egress policy", http.StatusForbidden)
			return
		}
	}
	// Forward plain HTTP only to the verified IPs, in resolver order.
	port := r.URL.Port()
	if port == "" {
		port = "80"
		if r.URL.Scheme == "https" {
			port = "443"
		}
	}
	target := dialTarget{addrs: make([]string, len(ips))}
	for i, ipAddr := range ips {
		target.addrs[i] = net.JoinHostPort(ipAddr.IP.String(), port)
	}
	// The transport detaches dials from the request deadline, so carry it explicitly.
	target.deadline, _ = ctx.Deadline()

	fwdCtx := context.WithValue(ctx, dialTargetKey, target)
	outReq, err := http.NewRequestWithContext(fwdCtx, r.Method, r.URL.String(), r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	outReq.Header = r.Header.Clone()

	resp, err := s.transport.RoundTrip(outReq)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for k, vv := range resp.Header {
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}
