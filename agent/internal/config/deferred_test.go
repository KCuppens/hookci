package config

import (
	"reflect"
	"testing"
)

func TestPlanJobsDeferredSetup(t *testing.T) {
	checks := &ResolvedChecks{
		Setup: []SetupStep{{Run: "install"}, {Run: "warm", For: []string{"rust", "after"}}},
		Jobs: []ResolvedJob{
			{Name: "web"},
			{Name: "rust"},
			{Name: "after", Needs: []string{"web"}},
		},
	}
	needs := map[string][]string{}
	var order []string
	for _, j := range PlanJobs(checks) {
		order = append(order, j.Name)
		needs[j.Name] = j.Needs
	}
	if want := []string{"setup", "setup-1", "web", "rust", "after"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	for name, want := range map[string][]string{
		"setup-1": {"setup"},
		"web":     {"setup"},
		"rust":    {"setup-1"},
		"after":   {"web", "setup-1"},
	} {
		if !reflect.DeepEqual(needs[name], want) {
			t.Errorf("%s needs %v, want %v", name, needs[name], want)
		}
	}
}
