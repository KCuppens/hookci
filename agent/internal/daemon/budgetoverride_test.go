package daemon

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/agentconf"
	"github.com/KCuppens/hookci/agent/internal/capacity"
	"github.com/KCuppens/hookci/agent/internal/store"
)

const gib = 1 << 30

func newBudgetDaemon(t *testing.T, stateDir string, def Budget) (*Daemon, *capacity.Pool) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	pool := capacity.New(capacity.Options{CPUs: def.CPUs, MemoryBytes: def.MemoryBytes, CPUCount: 16})
	d := New(&agentconf.AgentConfig{HubURL: "https://hub.invalid"}, st, nil,
		Options{StateDir: stateDir, Source: &fakeSource{}, Pool: pool, BudgetDefault: def})
	return d, pool
}

func budgetOf(p *capacity.Pool) Budget {
	s := p.Snapshot()
	return Budget{CPUs: s.BudgetCPUs, MemoryBytes: s.BudgetMemoryBytes}
}

func TestHubBudgetOverride(t *testing.T) {
	def := Budget{CPUs: 2, MemoryBytes: 4 * gib}
	tests := []struct {
		name string
		cpus *float64
		mem  *int64
		want Budget
	}{
		{"both", new(6.0), new(int64(8 * gib)), Budget{CPUs: 6, MemoryBytes: 8 * gib}},
		{"cpus only keeps the default memory", new(6.0), nil, Budget{CPUs: 6, MemoryBytes: 4 * gib}},
		{"memory only keeps the default cpus", nil, new(int64(8 * gib)), Budget{CPUs: 2, MemoryBytes: 8 * gib}},
		{"neither restores the default", nil, nil, def},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			d, pool := newBudgetDaemon(t, dir, def)
			d.HandleBudget(new(5.0), new(int64(1*gib)))
			d.HandleBudget(tc.cpus, tc.mem)
			if got := budgetOf(pool); got != tc.want {
				t.Errorf("budget = %+v, want %+v", got, tc.want)
			}

			_, restarted := newBudgetDaemon(t, dir, def)
			if got := budgetOf(restarted); got != tc.want {
				t.Errorf("budget after restart = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestHubBudgetClearRemovesFile(t *testing.T) {
	dir := t.TempDir()
	d, _ := newBudgetDaemon(t, dir, Budget{})
	d.HandleBudget(new(3.0), nil)
	if _, err := os.Stat(filepath.Join(dir, budgetOverrideFile)); err != nil {
		t.Fatalf("override not saved: %v", err)
	}
	d.HandleBudget(nil, nil)
	if _, err := os.Stat(filepath.Join(dir, budgetOverrideFile)); !os.IsNotExist(err) {
		t.Errorf("override file after clearing: %v", err)
	}
}

func TestCorruptBudgetOverrideIsIgnored(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, budgetOverrideFile), []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	def := Budget{CPUs: 2}
	_, pool := newBudgetDaemon(t, dir, def)
	if got := budgetOf(pool); got != def {
		t.Errorf("budget = %+v, want the default %+v", got, def)
	}
}
