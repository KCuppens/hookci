// The Slack sink's messages, as pure renderers: the run's message (posted
// once, then updated in place), a thread reply per finished job, the failure
// alert and the agent-offline DM. Every `text` starts with the state in plain
// words, so a notification or screen reader never relies on the emoji.

import { logJob } from "../sinks/runview";
import type { AgentView, JobView, RunState, RunView } from "../sinks/types";
import { S } from "../strings";
import { BADGE_EMOJI, escapeMrkdwn, formatDuration } from "./badge";
import { actions, type Block, button, context, section } from "./blocks";
import { viewLogsButton } from "./view-logs";

export interface SlackMessage {
	text: string;
	blocks: Block[];
}

/** Alert tail limits: Slack caps a section's text at 3000 characters. */
export const TAIL_LINES = 40;
const TAIL_LINE_CHARS = 300;
const TAIL_BLOCK_CHARS = 2900;
const OFFLINE_DM_RUNS = 10;
const SEP = " · ";

/** The plain word for a state; a run waiting for its offline agent says so. */
function stateWord(state: RunState, reason?: string): string {
	switch (state) {
		case "received":
		case "queued":
		case "gated":
			return S.slack.state.waiting;
		case "pending":
			return reason === "agent_offline" ? S.slack.state.agentOffline : S.slack.state.waiting;
		case "running":
		case "verifying":
		case "rolling_back":
			return S.slack.state.running;
		case "success":
			return S.slack.state.passed;
		case "failed":
			return S.slack.state.failed;
		case "cancelled":
		case "interrupted":
			return S.slack.state.cancelled;
		case "skipped":
			return S.slack.state.skipped;
		case "superseded":
			return S.slack.state.superseded;
	}
}

/** `PR #n`, or the branch or tag the run built; '' when unknown. */
function where(run: RunView): string {
	if (run.prNumber !== undefined) return S.slack.pullRequest(run.prNumber);
	return (run.ref ?? "").replace(/^refs\/(?:heads|tags)\//, "");
}

function repoLink(run: RunView): string {
	return `<https://github.com/${run.repo}|${escapeMrkdwn(run.repo)}>`;
}

function shaLink(run: RunView): string {
	return `<https://github.com/${run.repo}/commit/${run.sha}|${run.shortSha}>`;
}

function runText(run: RunView, word: string): string {
	return S.slack.runText(word, escapeMrkdwn(run.repo), run.shortSha, escapeMrkdwn(where(run)), escapeMrkdwn(run.commitTitle));
}

function pendingText(run: RunView): string | undefined {
	if (run.reason !== undefined) return S.slack.pending[run.reason];
	return run.state === "gated" ? S.slack.pending.fork_gated : undefined;
}

function jobLine(job: JobView): string {
	return S.slack.jobResult(escapeMrkdwn(job.name), stateWord(job.state), job.durationMs === undefined ? undefined : formatDuration(job.durationMs));
}

/**
 * The run's message: badge, state, repo, commit, ref, author, duration, the
 * running job's step and the log link. Quiet watches get no thread replies,
 * so their message lists each job's result instead.
 */
export function renderRunMessage(run: RunView, opts: { notify: "normal" | "quiet" }): SlackMessage {
	const word = stateWord(run.state, run.reason);
	const head = [`${BADGE_EMOJI[run.state]} *${word}* ${repoLink(run)}`, shaLink(run)];
	const ref = where(run);
	if (ref) head.push(escapeMrkdwn(ref));
	if (run.commitTitle) head.push(escapeMrkdwn(run.commitTitle));
	const blocks: Block[] = [section(head.join(SEP))];

	const pending = run.state === "pending" || run.state === "gated" ? pendingText(run) : undefined;
	if (pending) blocks.push(section(pending));
	if (run.state === "gated" && run.reason === "fork_gated") {
		blocks.push(actions(button("fork:approve", S.forks.approveButton, `${run.runId ?? run.triggerId}:${run.sha}`, "primary")));
	}
	if (run.approvedBy) blocks.push(context(S.forks.approvedBy(escapeMrkdwn(run.approvedBy))));

	const meta = [S.slack.author(escapeMrkdwn(run.authorLogin))];
	if (run.durationMs !== undefined) meta.push(formatDuration(run.durationMs));
	const current = run.state === "running" ? run.jobs.find((job) => job.name === run.currentJob) : undefined;
	if (current?.step) meta.push(escapeMrkdwn(S.slack.currentStep(current.name, current.step, current.stepIndex, current.stepsTotal)));
	const withLog = logJob(run);
	if (withLog?.logLink) meta.push(`<${withLog.logLink}|${S.badge.log}>`);
	blocks.push(context(meta.join(SEP)));
	if (withLog) blocks.push(actions(viewLogsButton(run.runId ?? run.triggerId, withLog.name)));

	if (opts.notify === "quiet" && run.jobs.length > 0) blocks.push(context(run.jobs.map(jobLine).join(SEP)));
	return { text: runText(run, word), blocks };
}

/** The thread reply for a job that reached its final state. */
export function renderJobReply(run: RunView, job: JobView): SlackMessage {
	const word = stateWord(job.state);
	const lines = [`${BADGE_EMOJI[job.state]} ${jobLine(job)}`];
	if (job.summary) lines.push(escapeMrkdwn(job.summary));
	if (job.reason) lines.push(escapeMrkdwn(S.slack.jobReason(job.reason)));
	return {
		text: S.slack.jobReplyText(word, escapeMrkdwn(job.name), escapeMrkdwn(run.repo), run.shortSha),
		blocks: [section(lines.join("\n"))],
	};
}

/**
 * The last TAIL_LINES lines in a code block: each cut to TAIL_LINE_CHARS,
 * then the oldest dropped until the block fits TAIL_BLOCK_CHARS.
 */
export function tailBlock(tail: readonly string[]): string {
	const lines = tail.slice(-TAIL_LINES).map((line) => escapeMrkdwn(line.length > TAIL_LINE_CHARS ? `${line.slice(0, TAIL_LINE_CHARS - 3)}...` : line));
	const fence = (body: string[]) => `\`\`\`\n${body.join("\n")}\n\`\`\``;
	let length = fence(lines).length;
	let start = 0;
	while (length >= TAIL_BLOCK_CHARS && start < lines.length) {
		length -= (lines[start] ?? "").length + 1;
		start++;
	}
	return fence(lines.slice(start));
}

/**
 * The failure alert: one mention at most, the failed job and step, the log
 * tail, the stable log link and View logs button; for a job whose logs stay
 * on the agent, only a note saying so.
 */
export function renderAlert(run: RunView, job: JobView, tail: string[], mention: string | null, logLink: string | null): SlackMessage {
	const head = [`${BADGE_EMOJI.failed} *${S.slack.state.failed}* ${repoLink(run)}`, shaLink(run)];
	const ref = where(run);
	if (ref) head.push(escapeMrkdwn(ref));
	const blocks: Block[] = [section(`${mention ? `<@${mention}> ` : ""}${head.join(SEP)}\n${escapeMrkdwn(S.slack.alertJob(job.name, job.step))}`)];
	if (job.logs === "local") {
		blocks.push(context(S.slack.logsLocal));
	} else {
		blocks.push(tail.length > 0 ? section(tailBlock(tail)) : context(S.slack.alertNoTail));
		if (logLink) blocks.push(context(`<${logLink}|${S.badge.log}>`), actions(viewLogsButton(run.runId ?? run.triggerId, job.name)));
	}
	return { text: S.slack.alertText(S.slack.state.failed, escapeMrkdwn(run.repo), run.shortSha, escapeMrkdwn(job.name)), blocks };
}

/** The DM to the agent's admin when it goes offline, listing the runs waiting for it. */
export function renderOfflineDm(agent: AgentView, affected: RunView[]): SlackMessage {
	const text = S.slack.offlineDmText(S.slack.state.agentOffline, escapeMrkdwn(agent.name), affected.length);
	const since = `<!date^${Math.floor(agent.lastSeenAt / 1000)}^{ago}|${new Date(agent.lastSeenAt).toISOString()}>`;
	const blocks: Block[] = [section(`${BADGE_EMOJI.pending} ${text}`), context(S.slack.offlineDmSince(since))];
	const runs = affected.slice(0, OFFLINE_DM_RUNS).map((run) => `${repoLink(run)}${SEP}${shaLink(run)}${where(run) ? `${SEP}${escapeMrkdwn(where(run))}` : ""}`);
	if (runs.length > 0) blocks.push(section(runs.join("\n")));
	return { text, blocks };
}
