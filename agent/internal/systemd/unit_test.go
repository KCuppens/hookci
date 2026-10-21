package systemd

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAgentUnitLegacyFallback(t *testing.T) {
	dir := t.TempDir()
	old := unitDir
	unitDir = dir
	t.Cleanup(func() { unitDir = old })

	touch := func(name string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	check := func(when, unit, all string) {
		t.Helper()
		if got := AgentUnit(42); got != unit {
			t.Errorf("%s: AgentUnit = %q, want %q", when, got, unit)
		}
		if got := AllAgentUnits(); got != all {
			t.Errorf("%s: AllAgentUnits = %q, want %q", when, got, all)
		}
	}

	check("no unit files", "hookci-agent@42.service", "hookci-agent@*.service")
	touch("zeroci-agent@.service")
	check("legacy only", "zeroci-agent@42.service", "zeroci-agent@*.service")
	touch("hookci-agent@.service")
	check("both", "hookci-agent@42.service", "hookci-agent@*.service")
}
