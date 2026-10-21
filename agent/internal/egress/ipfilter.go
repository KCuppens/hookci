package egress

import (
	"net"
	"net/netip"
)

// forbiddenPrefixes lists every range that is not public unicast.
var forbiddenPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("255.255.255.255/32"),
	netip.MustParsePrefix("::/128"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

// nat64Prefix is the well-known NAT64 prefix. A NAT64 gateway translates
// 64:ff9b::a.b.c.d to a.b.c.d, so the embedded IPv4 address is checked.
var nat64Prefix = netip.MustParsePrefix("64:ff9b::/96")

// IsForbiddenIP reports whether ip is not a public unicast address. Malformed
// addresses are forbidden.
func IsForbiddenIP(ip net.IP) bool {
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return true
	}
	return isForbiddenAddr(addr.Unmap())
}

func isForbiddenAddr(addr netip.Addr) bool {
	for _, p := range forbiddenPrefixes {
		if p.Contains(addr) {
			return true
		}
	}
	if nat64Prefix.Contains(addr) {
		b := addr.As16()
		return isForbiddenAddr(netip.AddrFrom4([4]byte(b[12:])))
	}
	return false
}
