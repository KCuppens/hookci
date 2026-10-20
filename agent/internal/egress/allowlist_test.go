package egress

import (
	"slices"
	"strings"
	"testing"
)

func TestNewAllowListDefaults(t *testing.T) {
	want := slices.Sorted(slices.Values(DefaultHosts))
	for _, trusted := range []bool{false, true} {
		a, warns, err := NewAllowList(trusted, nil)
		if err != nil || warns != nil {
			t.Fatalf("NewAllowList(%v, nil) = warns %v, err %v", trusted, warns, err)
		}
		if got := a.Hosts(); !slices.Equal(got, want) {
			t.Fatalf("trusted=%v: Hosts() = %v, want %v", trusted, got, want)
		}
		for _, h := range DefaultHosts {
			if !a.Allows(h) {
				t.Errorf("trusted=%v: Allows(%q) = false", trusted, h)
			}
		}
		for _, h := range []string{"github.com", "evil.com", "npmjs.org", "sub.registry.npmjs.org"} {
			if a.Allows(h) {
				t.Errorf("trusted=%v: Allows(%q) = true", trusted, h)
			}
		}
	}
}

func TestNewAllowListTrustedExtra(t *testing.T) {
	a, warns, err := NewAllowList(true, []string{"Registry.Example.COM."})
	if err != nil || warns != nil {
		t.Fatalf("NewAllowList = warns %v, err %v", warns, err)
	}
	if !a.Allows("registry.example.com") {
		t.Fatal("normalized extra host not allowed")
	}
	if !a.Allows("pypi.org") {
		t.Fatal("defaults missing when extras given")
	}
}

func TestNewAllowListUntrustedIgnoresExtra(t *testing.T) {
	a, warns, err := NewAllowList(false, []string{"registry.example.com", "*.bad"})
	if err != nil {
		t.Fatal(err)
	}
	if len(warns) != 1 || warns[0] != "egress additions ignored for untrusted run" {
		t.Fatalf("warns = %q, want exactly the untrusted warning", warns)
	}
	if a.Allows("registry.example.com") {
		t.Fatal("untrusted run allowed an extra host")
	}
	if got := a.Hosts(); len(got) != len(DefaultHosts) {
		t.Fatalf("Hosts() has %d entries, want %d", len(got), len(DefaultHosts))
	}
}

func TestNewAllowListRejectsBadEntries(t *testing.T) {
	for _, e := range []string{"1.2.3.4", "host:443", "https://x.com", "x.com/path", "*.x.com", "", "[::1]", "::1", "x_y.com"} {
		a, _, err := NewAllowList(true, []string{"ok.example.com", e})
		if err == nil {
			t.Errorf("NewAllowList(%q) = nil error", e)
			continue
		}
		if a != nil {
			t.Errorf("NewAllowList(%q) returned a list with the error", e)
		}
		if !strings.Contains(err.Error(), "\""+e+"\"") {
			t.Errorf("error %q does not name entry %q", err, e)
		}
	}
}

func TestNormalizeHost(t *testing.T) {
	good := map[string]string{
		"Example.COM":   "example.com",
		"example.com.":  "example.com",
		"a-b.c0.io":     "a-b.c0.io",
		"localhost":     "localhost",
		"REGISTRY-1.Io": "registry-1.io",
	}
	for in, want := range good {
		got, err := NormalizeHost(in)
		if err != nil || got != want {
			t.Errorf("NormalizeHost(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", ".", "a_b.com", "a b", "x.com:443", "é.com", strings.Repeat("a", 254)} {
		if got, err := NormalizeHost(in); err == nil {
			t.Errorf("NormalizeHost(%q) = %q, nil; want error", in, got)
		}
	}
}
