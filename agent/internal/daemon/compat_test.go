package daemon

import (
	"testing"

	"github.com/KCuppens/hookci/agent/internal/source"
)

func TestResolvePlanLegacyConfig(t *testing.T) {
	cases := []struct {
		name       string
		files      map[string]string
		wantLegacy bool
		wantJobs   bool
	}{
		{"legacy only", map[string]string{".zeroci.yml": unitOnly}, true, true},
		{"new only", map[string]string{ConfigFile: unitOnly}, false, true},
		{"both prefers new", map[string]string{ConfigFile: unitOnly, ".zeroci.yml": "version: 1\nchecks:\n  jobs: {}\n"}, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := writeTree(dir, tc.files); err != nil {
				t.Fatal(err)
			}
			p, err := resolvePlan(source.Checkout{Dir: dir})
			if err != nil {
				t.Fatal(err)
			}
			if p.legacy != tc.wantLegacy {
				t.Errorf("legacy = %v, want %v", p.legacy, tc.wantLegacy)
			}
			if (p.checks != nil) != tc.wantJobs {
				t.Errorf("checks = %v, want jobs %v", p.checks, tc.wantJobs)
			}
		})
	}
}
