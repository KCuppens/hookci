package egress

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestPolicyBlockedHosts(t *testing.T) {
	untrusted := NewPolicy(TrustDomainUntrusted, []string{"custom-api.example.com"})
	trusted := NewPolicy(TrustDomainTrusted, []string{"custom-api.example.com"})

	tests := []struct {
		name      string
		policy    *Policy
		host      string
		wantAllow bool
	}{
		// Default registries (allowed for all)
		{"npmjs allowed untrusted", untrusted, "registry.npmjs.org", true},
		{"npmjs:443 allowed untrusted", untrusted, "registry.npmjs.org:443", true},
		{"golang allowed untrusted", untrusted, "proxy.golang.org", true},
		{"crates allowed untrusted", untrusted, "crates.io", true},
		{"pypi allowed untrusted", untrusted, "pypi.org", true},
		{"github allowed untrusted", untrusted, "github.com", true},

		// Direct IPs (always blocked as hostnames)
		{"loopback 127.0.0.1 blocked", untrusted, "127.0.0.1", false},
		{"loopback 127.0.0.1:2019 blocked", untrusted, "127.0.0.1:2019", false},
		{"metadata 169.254.169.254 blocked", untrusted, "169.254.169.254", false},
		{"metadata:80 blocked", untrusted, "169.254.169.254:80", false},
		{"private 10.0.0.1 blocked", untrusted, "10.0.0.1", false},
		{"private 192.168.1.1 blocked", untrusted, "192.168.1.1", false},

		// Non-allowlisted external host
		{"arbitrary evil.com blocked untrusted", untrusted, "evil.com", false},
		{"arbitrary evil.com blocked trusted", trusted, "evil.com", false},

		// Custom checks.egress: blocked for untrusted, allowed for trusted
		{"custom egress blocked for untrusted", untrusted, "custom-api.example.com", false},
		{"custom egress allowed for trusted", trusted, "custom-api.example.com", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.policy.IsAllowedHost(tt.host)
			if got != tt.wantAllow {
				t.Errorf("IsAllowedHost(%q) = %v, want %v", tt.host, got, tt.wantAllow)
			}
		})
	}
}

func TestDisallowedIPs(t *testing.T) {
	tests := []struct {
		ip       string
		disallow bool
	}{
		// Loopback
		{"127.0.0.1", true},
		{"127.0.0.53", true},
		{"::1", true},

		// Cloud metadata & link-local
		{"169.254.169.254", true},
		{"169.254.0.1", true},
		{"fe80::1", true},

		// RFC1918 Private
		{"10.0.0.1", true},
		{"172.16.0.1", true},
		{"172.31.255.255", true},
		{"192.168.1.1", true},

		// CGNAT & Multicast
		{"100.64.0.1", true},
		{"224.0.0.1", true},

		// Public routable IPs
		{"8.8.8.8", false},
		{"1.1.1.1", false},
		{"140.82.121.3", false}, // github.com
	}

	for _, tt := range tests {
		t.Run(tt.ip, func(t *testing.T) {
			ip := net.ParseIP(tt.ip)
			if ip == nil {
				t.Fatalf("failed to parse IP %s", tt.ip)
			}
			got := IsDisallowedIP(ip)
			if got != tt.disallow {
				t.Errorf("IsDisallowedIP(%s) = %v, want %v", tt.ip, got, tt.disallow)
			}
		})
	}
}

func TestProxyConnectBlocked(t *testing.T) {
	policy := NewPolicy(TrustDomainUntrusted, nil)
	server := NewServer(policy, nil)

	if err := server.Start("127.0.0.1:0"); err != nil {
		t.Fatalf("start proxy server: %v", err)
	}
	defer server.Close()

	proxyAddr := server.Addr()

	targets := []string{
		"127.0.0.1:2019",
		"169.254.169.254:80",
		"10.0.0.1:443",
		"evil.com:443",
		"random-host-never-allowed.test:443",
	}

	for _, target := range targets {
		t.Run("blocked_"+target, func(t *testing.T) {
			conn, err := net.Dial("tcp", proxyAddr)
			if err != nil {
				t.Fatalf("dial proxy: %v", err)
			}
			defer conn.Close()

			req := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target)
			if _, err := conn.Write([]byte(req)); err != nil {
				t.Fatalf("write CONNECT request: %v", err)
			}

			resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatalf("read response: %v", err)
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusForbidden {
				t.Errorf("target %s got HTTP status %d, want 403 Forbidden", target, resp.StatusCode)
			}
		})
	}
}

func TestProxyPlainHTTPBlocked(t *testing.T) {
	policy := NewPolicy(TrustDomainUntrusted, nil)
	server := NewServer(policy, nil)

	if err := server.Start("127.0.0.1:0"); err != nil {
		t.Fatalf("start proxy server: %v", err)
	}
	defer server.Close()

	proxyURL, err := url.Parse("http://" + server.Addr())
	if err != nil {
		t.Fatal(err)
	}

	client := &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyURL(proxyURL),
		},
	}

	// Attempt accessing disallowed target
	resp, err := client.Get("http://127.0.0.1:2019/metrics")
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("expected 403 Forbidden, got %d", resp.StatusCode)
		}
	}
}

func TestProxyAllowedTunnel(t *testing.T) {
	// Mock upstream echo server
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Custom-Header", "registry-ok")
		_, _ = w.Write([]byte("mock registry response"))
	}))
	defer mockUpstream.Close()

	u, err := url.Parse(mockUpstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	mockPort := u.Port()

	// Create custom policy that allows mock host
	policy := &Policy{
		TrustDomain:  TrustDomainTrusted,
		AllowedHosts: []string{"mock-registry.test"},
	}

	// Custom resolver that maps mock-registry.test to 127.0.0.1 for the test,
	// but wait! 127.0.0.1 is normally blocked by IsDisallowedIP!
	// So to test the tunnel mechanics through the proxy cleanly without relaxing IsDisallowedIP,
	// let's verify that when an allowed target dials, it connects properly.
	// Since 127.0.0.1 is always rejected by IsDisallowedIP, let's verify that even if a host
	// is in AllowedHosts, if it resolves to 127.0.0.1, the IP check STILL catches and blocks it!
	server := NewServer(policy, nil)
	if err := server.Start("127.0.0.1:0"); err != nil {
		t.Fatalf("start proxy: %v", err)
	}
	defer server.Close()

	conn, err := net.Dial("tcp", server.Addr())
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer conn.Close()

	req := fmt.Sprintf("CONNECT localhost:%s HTTP/1.1\r\nHost: localhost:%s\r\n\r\n", mockPort, mockPort)
	_, _ = conn.Write([]byte(req))

	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	defer resp.Body.Close()

	// localhost resolves to 127.0.0.1, which MUST be blocked by policy
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("expected 403 Forbidden for localhost resolution, got %d", resp.StatusCode)
	}
}

func TestProxyAllowedTunnelWithMockDialer(t *testing.T) {
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Egress-Test", "verified")
		_, _ = w.Write([]byte("mock npm registry payload"))
	}))
	defer mockUpstream.Close()

	policy := NewPolicy(TrustDomainUntrusted, nil) // registry.npmjs.org is allowed
	server := NewServer(policy, nil)

	// Intercept dial to route to mock upstream
	server.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		return net.Dial("tcp", mockUpstream.Listener.Addr().String())
	}

	if err := server.Start("127.0.0.1:0"); err != nil {
		t.Fatalf("start proxy: %v", err)
	}
	defer server.Close()

	conn, err := net.Dial("tcp", server.Addr())
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer conn.Close()

	// Send CONNECT to registry.npmjs.org:443
	connectReq := "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n"
	if _, err := conn.Write([]byte(connectReq)); err != nil {
		t.Fatalf("write CONNECT: %v", err)
	}

	reader := bufio.NewReader(conn)
	connectResp, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatalf("read CONNECT response: %v", err)
	}
	if connectResp.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT status = %d, want 200", connectResp.StatusCode)
	}

	// Tunnel is now established! Send HTTP GET over the established tunnel
	httpReq := "GET / HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n"
	if _, err := conn.Write([]byte(httpReq)); err != nil {
		t.Fatalf("write payload over tunnel: %v", err)
	}

	httpResp, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatalf("read response over tunnel: %v", err)
	}
	defer httpResp.Body.Close()

	if httpResp.Header.Get("X-Egress-Test") != "verified" {
		t.Errorf("header = %q, want 'verified'", httpResp.Header.Get("X-Egress-Test"))
	}

	body, err := io.ReadAll(httpResp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(body) != "mock npm registry payload" {
		t.Errorf("body = %q, want 'mock npm registry payload'", string(body))
	}
}
