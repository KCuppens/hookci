package cli

import (
	"fmt"
	"math"
	"runtime"
	"strconv"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/daemon"
)

// Environment variables that default the agent's --cpu-budget and
// --mem-budget flags.
const (
	envCPUBudget = "HOOKCI_CPU_BUDGET"
	envMemBudget = "HOOKCI_MEM_BUDGET"
)

// parseBudget resolves the budget from --cpu-budget and --mem-budget values.
// An empty or 0 cpus is every CPU of the host; an empty mem is no memory
// budget.
func parseBudget(cpus, mem string) (daemon.Budget, error) {
	var b daemon.Budget
	if cpus != "" {
		v, err := strconv.ParseFloat(cpus, 64)
		if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
			return daemon.Budget{}, fmt.Errorf("--cpu-budget must be a non-negative number of cores, got %q", cpus)
		}
		b.CPUs = v
	}
	if b.CPUs == 0 {
		b.CPUs = float64(runtime.NumCPU())
	}
	if mem != "" {
		v, err := config.ParseMemory(mem)
		if err != nil {
			return daemon.Budget{}, fmt.Errorf("--mem-budget: %w", err)
		}
		b.MemoryBytes = v
	}
	return b, nil
}
