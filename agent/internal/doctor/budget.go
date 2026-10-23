package doctor

import (
	"context"
	"fmt"
)

// budgetCheck reports the host size, the CPU and memory budget the agent
// resolves from its flags and which signals it backs off on under load.
type budgetCheck struct{}

func (budgetCheck) ID() string { return "job_budget" }

func (budgetCheck) Run(_ context.Context, env Env) Result {
	const title = "job budget"
	if env.BudgetErr != nil {
		return fail(title, env.BudgetErr.Error(), "fix $HOOKCI_CPU_BUDGET and $HOOKCI_MEM_BUDGET")
	}
	if env.Host == nil {
		return skip(title, "host size not read")
	}
	s, err := env.Host.Sample()
	if err != nil {
		return skip(title, fmt.Sprintf("host not readable: %v", err))
	}
	detail := fmt.Sprintf("host %s, budget %s", sizeOf(float64(env.HostCPUs), s.MemTotal), budgetOf(env.BudgetCPUs, env.BudgetMemory))
	switch {
	case s.PSI:
		detail += "; lends idle CPU, backs off on pressure (PSI)"
	case s.MemAvailable > 0:
		detail += "; PSI unavailable, backs off on available memory and load, CPU is not lent"
	default:
		detail += "; no pressure signal, never backs off"
	}
	return pass(title, detail)
}

func sizeOf(cpus float64, mem int64) string {
	if mem <= 0 {
		return fmt.Sprintf("%g CPUs, memory unknown", cpus)
	}
	return fmt.Sprintf("%g CPUs, %.1f GiB", cpus, float64(mem)/(1<<30))
}

func budgetOf(cpus float64, mem int64) string {
	if mem <= 0 {
		return fmt.Sprintf("%g CPUs, no memory budget", cpus)
	}
	return sizeOf(cpus, mem)
}
