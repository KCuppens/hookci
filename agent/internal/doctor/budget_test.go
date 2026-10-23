package doctor

import (
	"errors"
	"strings"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/capacity"
)

type fakeHost struct{ s capacity.Sample }

func (h fakeHost) Sample() (capacity.Sample, error) { return h.s, nil }

type brokenHost struct{}

func (brokenHost) Sample() (capacity.Sample, error) {
	return capacity.Sample{}, errors.New("no procfs")
}

func TestBudgetCheck(t *testing.T) {
	psi := fakeHost{capacity.Sample{MemTotal: 32 << 30, MemAvailable: 24 << 30, PSI: true}}
	noPSI := fakeHost{capacity.Sample{MemTotal: 32 << 30, MemAvailable: 24 << 30}}
	blind := fakeHost{}

	tests := []struct {
		name string
		env  Env
		want Status
		in   string
	}{
		{"every CPU, no memory budget", Env{Host: psi, HostCPUs: 8, BudgetCPUs: 8}, Pass, "host 8 CPUs, 32.0 GiB, budget 8 CPUs, no memory budget; lends idle CPU, backs off on pressure (PSI)"},
		{"configured budget", Env{Host: psi, HostCPUs: 8, BudgetCPUs: 6, BudgetMemory: 24 << 30}, Pass, "budget 6 CPUs, 24.0 GiB"},
		{"no PSI falls back to memory", Env{Host: noPSI, HostCPUs: 8, BudgetCPUs: 8}, Pass, "PSI unavailable, backs off on available memory and load, CPU is not lent"},
		{"no signal at all", Env{Host: blind, HostCPUs: 8, BudgetCPUs: 8}, Pass, "memory unknown"},
		{"bad environment", Env{Host: psi, BudgetErr: errors.New("--cpu-budget must be a non-negative number of cores")}, Fail, "--cpu-budget"},
		{"host not read", Env{}, Skip, "host size not read"},
		{"host unreadable", Env{Host: brokenHost{}}, Skip, "no procfs"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := runOne(t, budgetCheck{}, tc.env)
			if r.Status != tc.want || !strings.Contains(r.Detail, tc.in) {
				t.Errorf("got %s %q, want %s containing %q", r.Status, r.Detail, tc.want, tc.in)
			}
		})
	}
}
