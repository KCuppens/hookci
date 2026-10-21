package egress

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"strings"
)

// DefaultHosts is the built-in registry allow-list (exact hostnames, lower case).
var DefaultHosts = []string{
	"registry.npmjs.org", "registry.yarnpkg.com",
	"pypi.org", "files.pythonhosted.org",
	"crates.io", "index.crates.io", "static.crates.io",
	"proxy.golang.org", "sum.golang.org",
	"registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com",
}

const untrustedExtraWarning = "egress additions ignored for untrusted run"

// AllowList is an immutable set of exact hostnames.
type AllowList struct{ hosts map[string]struct{} }

// NewAllowList returns DefaultHosts plus extra when trusted is true.
// When trusted is false and extra is non-empty, extra is ignored and a
// warning "egress additions ignored for untrusted run" is returned.
// Entries that are IP literals, contain a port, a scheme, a path or a
// wildcard return an error naming the entry.
func NewAllowList(trusted bool, extra []string) (*AllowList, []string, error) {
	a := &AllowList{hosts: make(map[string]struct{}, len(DefaultHosts)+len(extra))}
	for _, h := range DefaultHosts {
		a.hosts[h] = struct{}{}
	}
	if !trusted {
		if len(extra) > 0 {
			return a, []string{untrustedExtraWarning}, nil
		}
		return a, nil, nil
	}
	for _, e := range extra {
		h, err := parseEntry(e)
		if err != nil {
			return nil, nil, fmt.Errorf("egress entry %q: %s", e, err)
		}
		a.hosts[h] = struct{}{}
	}
	return a, nil, nil
}

// parseEntry validates one checks.egress entry and returns the normalized host.
func parseEntry(e string) (string, error) {
	switch {
	case e == "":
		return "", errors.New("empty entry")
	case strings.Contains(e, "://"):
		return "", errors.New("a scheme is not allowed; give the bare host name")
	case strings.Contains(e, "/"):
		return "", errors.New("a path is not allowed; give the bare host name")
	case strings.Contains(e, "*"):
		return "", errors.New("wildcards are not allowed; list each exact host name")
	}
	if host, _, err := net.SplitHostPort(e); err == nil {
		if isIPLiteral(host) {
			return "", errors.New("IP literals are not allowed; give a host name")
		}
		return "", errors.New("a port is not allowed; only port 443 is proxied")
	}
	if isIPLiteral(strings.Trim(e, "[]")) {
		return "", errors.New("IP literals are not allowed; give a host name")
	}
	h, err := NormalizeHost(e)
	if err != nil {
		return "", err
	}
	if isIPLiteral(h) {
		return "", errors.New("IP literals are not allowed; give a host name")
	}
	return h, nil
}

func isIPLiteral(s string) bool {
	_, err := netip.ParseAddr(s)
	return err == nil
}

// Allows reports whether host (already normalized) is in the list.
func (a *AllowList) Allows(host string) bool {
	_, ok := a.hosts[host]
	return ok
}

// Hosts returns the sorted host list (used by logs and tests).
func (a *AllowList) Hosts() []string {
	out := make([]string, 0, len(a.hosts))
	for h := range a.hosts {
		out = append(out, h)
	}
	slices.Sort(out)
	return out
}

// NormalizeHost lower-cases, strips one trailing dot, and rejects empty
// or over-253-byte names and names with characters outside [a-z0-9.-].
func NormalizeHost(h string) (string, error) {
	h = strings.TrimSuffix(strings.ToLower(h), ".")
	switch {
	case h == "":
		return "", errors.New("empty host name")
	case len(h) > 253:
		return "", errors.New("host name longer than 253 bytes")
	}
	for i := range len(h) {
		c := h[i]
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '.' && c != '-' {
			return "", fmt.Errorf("host name %q has characters outside [a-z0-9.-]", h)
		}
	}
	return h, nil
}
