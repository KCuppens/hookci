package cli

// Exit codes returned by Main. The zeroci-agent@ unit does not restart an
// agent that exits with ExitNotConfigured, ExitRevoked or ExitAgentTooOld:
// a restart cannot fix any of them.
const (
	// ExitOK indicates the command completed successfully.
	ExitOK = 0
	// ExitRunFailed indicates a run (build, test, deploy step) failed.
	ExitRunFailed = 1
	// ExitUsage indicates invalid command-line usage.
	ExitUsage = 2
	// ExitNoChecks indicates no checks were configured to run.
	ExitNoChecks = 3
	// ExitNotConfigured is zeroci agent finding no usable agent.json in
	// its state directory; it shares its value with ExitNoChecks.
	ExitNotConfigured = 3
	// ExitRevoked indicates the hub revoked the agent; it shares its value
	// with ExitNoChecks.
	ExitRevoked = 3
	// ExitAgentTooOld is the hub refusing this agent version for good.
	ExitAgentTooOld = 4
	// ExitInternal indicates an internal error unrelated to user input.
	ExitInternal = 5
	// ExitUpgradeAvailable is `zeroci upgrade --check` finding a newer
	// release.
	ExitUpgradeAvailable = 10
)
