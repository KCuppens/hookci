package egress

import (
	"net"
	"testing"
)

func TestIsForbiddenIP(t *testing.T) {
	forbidden := []string{
		"127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254",
		"100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1",
		"::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe",
		"192.0.0.1", "198.18.0.1", "240.0.0.1", "255.255.255.255", "::", "ff02::1",
	}
	for _, s := range forbidden {
		if !IsForbiddenIP(net.ParseIP(s)) {
			t.Errorf("IsForbiddenIP(%s) = false, want true", s)
		}
	}
	allowed := []string{"93.184.216.34", "1.1.1.1", "2606:4700::1111", "64:ff9b::5db8:d822"}
	for _, s := range allowed {
		if IsForbiddenIP(net.ParseIP(s)) {
			t.Errorf("IsForbiddenIP(%s) = true, want false", s)
		}
	}
	if !IsForbiddenIP(nil) {
		t.Error("IsForbiddenIP(nil) = false, want true")
	}
	if !IsForbiddenIP(net.IP{1, 2, 3}) {
		t.Error("IsForbiddenIP(3-byte IP) = false, want true")
	}
}
