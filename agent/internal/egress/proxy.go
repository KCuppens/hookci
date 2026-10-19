package egress

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

// Server is a per-run HTTP CONNECT proxy enforcing strict egress domain allowlists
// and anti-SSRF IP blocking.
type Server struct {
	Policy      *Policy
	Resolver    *net.Resolver
	DialContext func(ctx context.Context, network, addr string) (net.Conn, error)

	listener net.Listener
	server   *http.Server
	mu       sync.Mutex
}

// NewServer constructs an egress proxy Server.
func NewServer(policy *Policy, resolver *net.Resolver) *Server {
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	s := &Server{
		Policy:   policy,
		Resolver: resolver,
	}
	s.server = &http.Server{
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
	}
	return s
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
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
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
	dialFn := s.DialContext
	if dialFn == nil {
		dialer := &net.Dialer{Timeout: 10 * time.Second}
		dialFn = dialer.DialContext
	}
	targetAddr := net.JoinHostPort(allowedIP.String(), port)
	upstreamConn, err := dialFn(ctx, "tcp", targetAddr)
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

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
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

	// Forward plain HTTP request
	outReq, err := http.NewRequestWithContext(ctx, r.Method, r.URL.String(), r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	outReq.Header = r.Header.Clone()

	transport := &http.Transport{
		DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
	}
	resp, err := transport.RoundTrip(outReq)
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
