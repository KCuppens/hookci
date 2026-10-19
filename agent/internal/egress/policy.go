package egress

import (
	"net"
	"strings"
)

// TrustDomain partitions egress network permissions.
type TrustDomain string

const (
	TrustDomainUntrusted TrustDomain = "untrusted"
	TrustDomainTrusted   TrustDomain = "trusted"
	TrustDomainLocal     TrustDomain = "local"
)

// DefaultAllowedRegistries contains the baseline package registries and VCS hosts
// required for dependency resolution across supported ecosystems.
var DefaultAllowedRegistries = []string{
	// Go
	"proxy.golang.org",
	"sum.golang.org",
	// Node / JS
	"registry.npmjs.org",
	"registry.yarnpkg.com",
	// Rust
	"crates.io",
	"index.crates.io",
	"static.crates.io",
	// Python
	"pypi.org",
	"files.pythonhosted.org",
	// GitHub / Git dependencies
	"github.com",
	"api.github.com",
	"codeload.github.com",
	"raw.githubusercontent.com",
	"objects.githubusercontent.com",
}

var disallowedCIDRs []*net.IPNet

func init() {
	cidrs := []string{
		"0.0.0.0/8",       // Current network
		"10.0.0.0/8",      // Private RFC1918
		"100.64.0.0/10",   // CGNAT
		"127.0.0.0/8",     // Loopback
		"169.254.0.0/16",  // Link-local / Cloud metadata (e.g. 169.254.169.254)
		"172.16.0.0/12",   // Private RFC1918
		"192.0.0.0/24",    // IETF protocol assignments
		"192.0.2.0/24",    // Documentation TEST-NET-1
		"192.168.0.0/16",  // Private RFC1918
		"198.18.0.0/15",   // Benchmarking
		"198.51.100.0/24", // Documentation TEST-NET-2
		"203.0.113.0/24",  // Documentation TEST-NET-3
		"224.0.0.0/4",     // Multicast
		"240.0.0.0/4",     // Reserved
		"::/128",          // Unspecified
		"::1/128",         // Loopback
		"fc00::/7",        // Unique Local Address
		"fe80::/10",       // Link-local
		"ff00::/8",        // Multicast
	}

	for _, c := range cidrs {
		_, ipNet, err := net.ParseCIDR(c)
		if err == nil {
			disallowedCIDRs = append(disallowedCIDRs, ipNet)
		}
	}
}

// Policy specifies egress network allowlists and domain trust boundaries.
type Policy struct {
	TrustDomain  TrustDomain
	AllowedHosts []string
	ExtraEgress  []string // custom egress specified in checks.egress
}

// NewPolicy creates a Policy with default allowed registries.
func NewPolicy(domain TrustDomain, extraEgress []string) *Policy {
	hosts := make([]string, len(DefaultAllowedRegistries))
	copy(hosts, DefaultAllowedRegistries)

	return &Policy{
		TrustDomain:  domain,
		AllowedHosts: hosts,
		ExtraEgress:  extraEgress,
	}
}

// IsAllowedHost checks whether the hostname matches the egress policy.
func (p *Policy) IsAllowedHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))

	// Strip port if present
	if strings.Contains(h, ":") {
		if hostPart, _, err := net.SplitHostPort(h); err == nil {
			h = hostPart
		}
	}

	// Direct IP addresses are never considered allowed hostnames
	if ip := net.ParseIP(h); ip != nil {
		return false
	}

	// 1. Check default allowed registries
	for _, allowed := range p.AllowedHosts {
		if matchHost(h, allowed) {
			return true
		}
	}

	// 2. Untrusted runs are strictly restricted to default registries (no custom egress)
	if p.TrustDomain == TrustDomainUntrusted {
		return false
	}

	// 3. Trusted and local runs may access custom checks.egress hosts
	for _, extra := range p.ExtraEgress {
		if matchHost(h, extra) {
			return true
		}
	}

	return false
}

// IsDisallowedIP checks whether an IP address belongs to loopback, link-local,
// cloud metadata, or private IP address spaces.
func IsDisallowedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}

	// Direct loopback or unspecified checks
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsPrivate() {
		return true
	}

	// Subnet CIDR checks
	for _, cidr := range disallowedCIDRs {
		if cidr.Contains(ip) {
			return true
		}
	}

	return false
}

func matchHost(target, pattern string) bool {
	t := strings.ToLower(target)
	p := strings.ToLower(pattern)

	if t == p {
		return true
	}

	// Subdomain wildcard matching (e.g. *.npmjs.org)
	if strings.HasPrefix(p, "*.") {
		domain := p[2:]
		if t == domain || strings.HasSuffix(t, "."+domain) {
			return true
		}
	}

	return false
}
