// What sinks (GitHub checks, Slack, ...) receive about runs and agents.

import type { TrustRefusal } from "../policy/trust";

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
	/** The last log lines of the job, as the agent sent them with its final state. */
	tail?: string[];
	/** "local" when the repo keeps its logs on the agent: nothing is uploaded and the agent sends no tail. */
	logs?: "local";
	/** The stable log link (HUB_ORIGIN/runs/<run>/logs?job=<job>) once the agent uploaded the job's log. */
	logLink?: string;
}
export interface RunView {
	installationId: number;
	repoId: number;
	repo: string;
	triggerId: string;
	runId?: string;
	/** The dashboard run page (HUB_ORIGIN/app/<installation>/runs/<run>), once the agent accepted the run. */
	runLink?: string;
	sha: string;
	shortSha: string;
	/** The git ref the run built, as refs/heads/main. */
	ref?: string;
	event: "pull_request" | "push";
	prNumber?: number;
	fork?: boolean;
	target: string;
	state: RunState;
	reason?: PendingReason;
	/** Why the base ref's `trust: all` was refused, on a gated fork run. */
	trustRefused?: TrustRefusal;
	commitTitle: string;
	authorLogin: string;
	authorEmail?: string;
	/** The GitHub login that approved this fork run, on the update that dispatched it. */
	approvedBy?: string;
	startedAt?: number;
	finishedAt?: number;
	durationMs?: number;
	jobs: JobView[];
	currentJob?: string;
	/** The .hookci.yml notify.slack override: channel is a name without #; notify and alert fall back to the watch's. */
	slack?: { channel: string; notify?: "normal" | "quiet"; alert?: "channel" | "dm" };
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
