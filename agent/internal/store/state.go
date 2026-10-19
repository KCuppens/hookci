package store

// RunState represents the lifecycle state of a run owned by the agent.
type RunState string

const (
	RunStateQueued      RunState = "Queued"
	RunStateRunning     RunState = "Running"
	RunStateSuccess     RunState = "Success"
	RunStateFailed      RunState = "Failed"
	RunStateVerifying   RunState = "Verifying"
	RunStateRollingBack RunState = "RollingBack"
	RunStateInterrupted RunState = "Interrupted"
	RunStateSuperseded  RunState = "Superseded"
)

// JobState represents the execution status of a single check job within a run.
type JobState string

const (
	JobStateQueued    JobState = "queued"
	JobStateRunning   JobState = "running"
	JobStateSuccess   JobState = "success"
	JobStateFailed    JobState = "failed"
	JobStateCancelled JobState = "cancelled"
	JobStateSkipped   JobState = "skipped"
)

// TrustDomain partitions caches, permissions, and egress capabilities.
type TrustDomain string

const (
	TrustDomainTrusted   TrustDomain = "trusted"
	TrustDomainUntrusted TrustDomain = "untrusted"
	TrustDomainLocal     TrustDomain = "local"
)
