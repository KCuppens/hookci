// The one-line Slack badge of a run: emoji by state, then target, commit,
// progress or outcome. Shared by /hookci watch (test badge), /hookci status
// and the Slack sink.

import { logJob } from "../sinks/runview";
import type { JobView, RunState, RunView } from "../sinks/types";
import { S } from "../strings";
import { type ContextBlock, context, type SectionBlock, section } from "./blocks";

export interface Badge {
	text: string;
	blocks: (SectionBlock | ContextBlock)[];
}

const SEP = " · ";
/** Run states that do not change again. */
export const TERMINAL: ReadonlySet<RunState> = new Set(["success", "failed", "cancelled", "skipped", "interrupted", "superseded"]);

/** The badge shortcode of each state; decoration only, every message also says the state in words. */
export const BADGE_EMOJI: Record<RunState, string> = {
	received: ":large_yellow_circle:",
	queued: ":large_yellow_circle:",
	running: ":large_yellow_circle:",
	verifying: ":large_yellow_circle:",
	rolling_back: ":large_yellow_circle:",
	success: ":large_green_circle:",
	failed: ":red_circle:",
	cancelled: ":white_circle:",
	superseded: ":white_circle:",
	skipped: ":white_circle:",
	interrupted: ":white_circle:",
	pending: ":black_circle:",
	gated: ":black_circle:",
};

/** 41.2s under a minute, 2m04s under an hour, 1h02m03s from there. */
export function formatDuration(ms: number): string {
	const tenths = Math.round(ms / 100);
	if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
	const total = Math.round(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = String(total % 60).padStart(2, "0");
	return h > 0 ? `${h}h${String(m).padStart(2, "0")}m${s}s` : `${m}m${s}s`;
}

/** Slack mrkdwn treats &, < and > as control characters. */
export function escapeMrkdwn(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function outcomeSummary(run: RunView): string | undefined {
	if (run.jobs.length === 0) return undefined;
	const summaries = run.jobs.flatMap((job) => (job.summary ? [job.summary] : []));
	if (summaries.length > 0) return escapeMrkdwn(summaries.join(", "));
	const failed = run.jobs.filter((job: JobView) => job.state === "failed").map((job) => escapeMrkdwn(job.name));
	if (run.state === "failed" && failed.length > 0) return S.badge.jobsFailed(failed.join(", "));
	return S.badge.jobsPassed(run.jobs.filter((job) => job.state === "success").length, run.jobs.length);
}

function blockedText(run: RunView): string {
	switch (run.reason) {
		case "daily_cap":
			return S.badge.dailyCap;
		case "fork_gated":
			return S.badge.forkGated;
		case "fork_never":
			return S.badge.forkNever;
		case "suspended":
			return S.badge.suspended;
		case "no_config":
			return S.noChecks;
		case "agent_offline":
		case "no_agent":
			return S.badge.agentOffline;
		default:
			return run.state === "gated" ? S.badge.forkGated : S.badge.agentOffline;
	}
}

function badgeText(run: RunView, test: boolean): string {
	const head = `${escapeMrkdwn(run.target)}${SEP}${run.shortSha}`;
	switch (run.state) {
		case "received":
		case "queued":
		case "running":
		case "verifying":
		case "rolling_back": {
			const done = run.jobs.filter((job) => TERMINAL.has(job.state)).length;
			const progress =
				run.jobs.length === 0
					? run.state === "received"
						? "queued"
						: run.state
					: `${done}/${run.jobs.length}${run.currentJob ? ` ${escapeMrkdwn(run.currentJob)}` : ""}`;
			return `${BADGE_EMOJI[run.state]} ${escapeMrkdwn(run.repo)}${SEP}${head} "${escapeMrkdwn(run.commitTitle)}"${SEP}${progress}`;
		}
		case "success":
		case "failed": {
			const parts = [`${BADGE_EMOJI[run.state]} ${head}`];
			if (run.durationMs !== undefined) parts.push(formatDuration(run.durationMs));
			const summary = outcomeSummary(run);
			if (summary) parts.push(summary);
			const logLink = logJob(run)?.logLink;
			if (logLink && !test) parts.push(`<${logLink}|${S.badge.log}>`);
			const text = parts.join(SEP);
			return test ? `${text} ${S.badge.test}` : text;
		}
		case "cancelled":
		case "superseded":
		case "skipped":
		case "interrupted": {
			const parts = [`${BADGE_EMOJI[run.state]} ${head}`, run.state];
			if (run.durationMs !== undefined) parts.push(formatDuration(run.durationMs));
			return parts.join(SEP);
		}
		case "pending":
		case "gated":
			return `${BADGE_EMOJI[run.state]} ${blockedText(run)}`;
	}
}

/** The badge of run; test marks the badge /hookci watch posts, which carries `(test)` and no log link. */
export function renderBadge(run: RunView, opts: { test?: boolean } = {}): Badge {
	const test = opts.test === true;
	const text = badgeText(run, test);
	return { text, blocks: test ? [section(text), context(S.badge.testNote(escapeMrkdwn(run.repo)))] : [section(text)] };
}
