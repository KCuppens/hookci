// Pure mapping from runs and jobs to GitHub check run states and texts, and
// from sink annotations to GitHub annotations.

import type { CheckRunAction, CheckRunAnnotation, CheckRunConclusion, CheckRunOutput, CheckRunStatus } from "../github/types";
import { QUOTAS } from "../quotas";
import type { Annotation, JobView, PendingReason, RunView } from "../sinks/types";
import { S } from "../strings";

export type CheckStatus = CheckRunStatus;
export type CheckConclusion = CheckRunConclusion;

/** A check run's status; a conclusion exactly when it is completed. */
export type CheckState = { status: "queued" | "in_progress" } | { status: "completed"; conclusion: CheckConclusion };

export type CheckView = CheckState & CheckRunOutput & { actions?: CheckRunAction[] };

/** The requested_action identifier of the aggregate check's approve button. */
export const APPROVE_ACTION = "approve_run";

/** The conclusions a job check can reach. */
export type JobConclusion = Extract<CheckConclusion, "success" | "failure" | "timed_out" | "cancelled" | "skipped">;
export type JobCheckState = { status: "queued" | "in_progress" } | { status: "completed"; conclusion: JobConclusion };

/** The job the agent validates `.hookci.yml` under; it never counts toward the aggregate. */
export const CONFIG_JOB = "_config";

/** The job that stands for the run's setup phase (checkout, config, caches, services, setup steps). It is an ordinary job row, check run and count. */
export const SETUP_JOB = "setup";

/** GitHub accepts at most this many annotations per check run request. */
export const ANNOTATIONS_PER_REQUEST = 50;

export function jobToCheck(job: JobView): JobCheckState {
	switch (job.state) {
		case "received":
		case "gated":
		case "pending":
		case "queued":
			return { status: "queued" };
		case "running":
		case "verifying":
		case "rolling_back":
			return { status: "in_progress" };
		case "success":
			return { status: "completed", conclusion: "success" };
		case "failed":
			return { status: "completed", conclusion: job.reason === "timeout" ? "timed_out" : "failure" };
		case "skipped":
			return { status: "completed", conclusion: "skipped" };
		case "cancelled":
		case "superseded":
		case "interrupted":
			return { status: "completed", conclusion: "cancelled" };
		default: {
			const _exhaustive: never = job.state;
			return _exhaustive;
		}
	}
}

/** The title and summary of an aggregate check that waits on someone. */
export function actionRequiredText(reason: PendingReason, ctx: { hubOrigin: string; repo: string }): CheckRunOutput {
	switch (reason) {
		case "agent_offline":
		case "fork_gated":
		case "fork_never":
		case "suspended":
			return { title: S.checks[reason].title, summary: S.checks[reason].summary };
		case "no_agent":
			return { title: S.checks.no_agent.title, summary: S.checks.no_agent.summary(ctx.hubOrigin, ctx.repo) };
		case "daily_cap":
			return { title: S.checks.daily_cap.title, summary: S.checks.daily_cap.summary(QUOTAS.runsPerDay) };
		case "no_config":
			return { title: S.noChecks, summary: S.checks.noConfigSummary };
		default: {
			const _exhaustive: never = reason;
			return _exhaustive;
		}
	}
}

/** The `hookci` check for the run: its jobs other than `_config`, or why it is waiting. */
export function aggregateFor(run: RunView, hubOrigin: string): CheckView {
	const jobs = run.jobs.filter((job) => job.name !== CONFIG_JOB);
	const summary = jobsSummary(jobs);
	switch (run.state) {
		case "gated":
		case "pending": {
			const reason = run.reason ?? (run.state === "gated" ? "fork_gated" : undefined);
			if (!reason) return { status: "in_progress", title: S.checks.state.queued, summary };
			const text = actionRequiredText(reason, { hubOrigin, repo: run.repo });
			// A refused `trust: all` says why the fork still waits on a maintainer.
			const output = run.trustRefused ? { ...text, summary: `${text.summary}\n\n${S.checks.trustRefused[run.trustRefused]}` } : text;
			if (reason === "fork_gated") {
				const actions = [{ label: S.forks.approveButton, description: S.forks.approveDescription, identifier: APPROVE_ACTION }];
				return { status: "completed", conclusion: "action_required", ...output, actions };
			}
			return { status: "completed", conclusion: "action_required", ...output };
		}
		case "received":
		case "queued":
			return { status: "in_progress", title: S.checks.state.queued, summary };
		case "running":
		case "verifying":
		case "rolling_back":
			return { status: "in_progress", title: S.checks.state.in_progress, summary };
		case "success": {
			const conclusion = conclusionOver(jobs);
			const failed = jobs.filter((job) => job.state === "failed").map((job) => job.name);
			return { status: "completed", conclusion, title: conclusion === "failure" ? S.checks.failedJobs(failed) : S.checks.state[conclusion], summary };
		}
		case "failed": {
			const failed = jobs.filter((job) => job.state === "failed").map((job) => job.name);
			return { status: "completed", conclusion: "failure", title: failed.length > 0 ? S.checks.failedJobs(failed) : S.checks.state.failure, summary };
		}
		case "cancelled":
		case "interrupted":
			return { status: "completed", conclusion: "cancelled", title: S.checks.state.cancelled, summary };
		case "superseded":
			return { status: "completed", conclusion: "cancelled", title: S.checks.state.cancelled, summary: S.checks.superseded };
		case "skipped":
			if (run.reason === "no_config") return { status: "completed", conclusion: "skipped", ...actionRequiredText("no_config", { hubOrigin, repo: run.repo }) };
			return { status: "completed", conclusion: "skipped", title: S.checks.state.skipped, summary };
		default: {
			const _exhaustive: never = run.state;
			return _exhaustive;
		}
	}
}

/** Any failure fails; all success or skipped (or no jobs) succeeds; anything else is cancelled. */
function conclusionOver(jobs: readonly JobView[]): "success" | "failure" | "cancelled" {
	if (jobs.some((job) => job.state === "failed")) return "failure";
	if (jobs.every((job) => job.state === "success" || job.state === "skipped")) return "success";
	return "cancelled";
}

function jobsSummary(jobs: readonly JobView[]): string {
	if (jobs.length === 0) return S.checks.noJobs;
	return jobs
		.map((job) => {
			const state = jobToCheck(job);
			const word = S.checks.state[state.status === "completed" ? state.conclusion : state.status];
			return S.checks.jobLine(job.name, word, job.durationMs === undefined ? undefined : formatDuration(job.durationMs));
		})
		.join("\n");
}

/** The `hookci/<job>` check: state and step as the title, step progress and duration as the summary. */
export function jobCheck(job: JobView): CheckView {
	const state = jobToCheck(job);
	const word = S.checks.state[state.status === "completed" ? state.conclusion : state.status];
	const lines: string[] = [];
	if (job.step !== undefined) {
		lines.push(
			job.stepIndex !== undefined && job.stepsTotal !== undefined
				? S.checks.stepProgress(job.stepIndex + 1, job.stepsTotal, job.step)
				: S.checks.currentStep(job.step),
		);
	}
	if (job.durationMs !== undefined) lines.push(S.checks.tookDuration(formatDuration(job.durationMs)));
	const title = state.status === "in_progress" && job.step !== undefined ? `${word}: ${job.step}` : word;
	return { ...state, title, summary: lines.length > 0 ? lines.join("\n") : S.checks.waitingToStart };
}

/** The `hookci/config` check: always neutral, titled by whether `.hookci.yml` validated. */
export function configCheck(job: JobView): CheckView {
	const title = job.state === "success" ? S.checks.configValid : job.state === "failed" ? S.checks.configInvalid : S.checks.configChecking;
	return { status: "completed", conclusion: "neutral", title, summary: job.reason ?? title };
}

function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Splits annotations into GitHub-sized requests, in order. */
export function chunkAnnotations<T>(annotations: readonly T[], size = ANNOTATIONS_PER_REQUEST): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < annotations.length; i += size) chunks.push(annotations.slice(i, i + size));
	return chunks;
}

export function toGithubAnnotation(a: Annotation): CheckRunAnnotation {
	return {
		path: a.path,
		start_line: a.start_line,
		end_line: a.end_line,
		annotation_level: a.level,
		message: a.message,
		...(a.title === undefined ? {} : { title: a.title }),
	};
}
