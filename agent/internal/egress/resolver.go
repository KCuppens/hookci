package egress

import (
	"context"
	"net"
)

// Resolver resolves a host name to IP addresses.
type Resolver interface {
	LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error)
}

// NetResolver resolves through net.DefaultResolver.
type NetResolver struct{}

// LookupIPAddr implements Resolver.
func (NetResolver) LookupIPAddr(ctx context.Context, host string) ([]net.IPAddr, error) {
	return net.DefaultResolver.LookupIPAddr(ctx, host)
}

// FakeResolver is a fixed host to addresses table for tests. A missing host
// returns a *net.DNSError with IsNotFound set.
type FakeResolver map[string][]net.IP

// LookupIPAddr implements Resolver.
func (f FakeResolver) LookupIPAddr(_ context.Context, host string) ([]net.IPAddr, error) {
	ips, ok := f[host]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	out := make([]net.IPAddr, len(ips))
	for i, ip := range ips {
		out[i] = net.IPAddr{IP: ip}
	}
	return out, nil
}
