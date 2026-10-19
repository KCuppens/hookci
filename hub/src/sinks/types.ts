// What sinks (GitHub checks, Slack, ...) receive about runs and agents.

export type RunState =
	| "received"
	| "gated"
	| "pending"
	| "superseded"
	| "queued"
	| "running"
	| "success"
	| "failed"
	| "cancelled"
	| "skipped"
	| "interrupted"
	| "verifying"
	| "rolling_back";
export type PendingReason = "no_agent" | "agent_offline" | "daily_cap" | "fork_gated" | "fork_never" | "suspended" | "no_config";
export interface JobView {
	name: string;
	state: RunState;
	durationMs?: number;
	summary?: string;
	step?: string;
	stepIndex?: number;
	stepsTotal?: number;
	/** Why the state last changed, as the agent reported it (for example "timeout"). */
	reason?: string;
}
export interface RunView {
	installationId: number;
	repoId: number;
	repo: string;
	triggerId: string;
	runId?: string;
	sha: string;
	shortSha: string;
	event: "pull_request" | "push";
	prNumber?: number;
	fork?: boolean;
	target: string;
	state: RunState;
	reason?: PendingReason;
	commitTitle: string;
	authorLogin: string;
	authorEmail?: string;
	startedAt?: number;
	finishedAt?: number;
	durationMs?: number;
	logUrl?: string;
	jobs: JobView[];
	currentJob?: string;
}
export interface AgentView {
	agentId: string;
	installationId: number;
	name: string;
	lastSeenAt: number;
}
export interface Annotation {
	path: string;
	start_line: number;
	end_line: number;
	level: "notice" | "warning" | "failure";
	message: string;
	title?: string;
}
export interface Sink {
	name: string;
	onRunUpdate(run: RunView): Promise<void>;
	onJobPlanned(run: RunView): Promise<void>;
	onJobUpdate(run: RunView, job: JobView): Promise<void>;
	onAnnotations(run: RunView, job: string, annotations: Annotation[]): Promise<void>;
	onAgentOffline(agent: AgentView, affected: RunView[]): Promise<void>;
}
