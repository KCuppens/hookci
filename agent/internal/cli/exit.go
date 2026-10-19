package cli

// Exit codes returned by Main.
const (
	// ExitOK indicates the command completed successfully.
	ExitOK = 0
	// ExitRunFailed indicates a run (build, test, deploy step) failed.
	ExitRunFailed = 1
	// ExitUsage indicates invalid command-line usage.
	ExitUsage = 2
	// ExitNoChecks indicates no checks were configured to run.
	ExitNoChecks = 3
	// ExitRevoked indicates the hub revoked the agent; it shares its value
	// with ExitNoChecks.
	ExitRevoked = 3
	// ExitInternal indicates an internal error unrelated to user input.
	ExitInternal = 4
)
