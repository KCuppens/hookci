// The Telegram sink: one message per run in the configured chat, sent with
// sendMessage and then edited in place with editMessageText as the run moves
// on. The outbox hands it only a run's latest update; a render equal to the
// last one sent is not sent again. The bot token sits in every API URL, so no
// URL is logged or thrown without redactTelegramUrl.

import { CONFIG_JOB, jobToCheck } from "../checks/map";
import { sha256Hex } from "../crypto";
import { getSinkMessage, putSinkMessage, type SinkMessage } from "../db/sinks";
import { tenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { defaultFetcher, type Fetcher } from "../http";
import { getLogTail } from "../logs/tail";
import { formatDuration } from "../slack/badge";
import { S } from "../strings";
import { type Deliverer, type DeliveryResult, registerDeliverer } from "./deliverers";
import { logJob } from "./runview";
import type { JobView, RunView } from "./types";

/** Telegram rejects a message text longer than this. */
export const TELEGRAM_MAX_CHARS = 4096;
/** A failed run shows at most this many of its failed job's last log lines... */
export const TELEGRAM_TAIL_LINES = 10;
/** ...in at most this many characters. */
export const TELEGRAM_TAIL_CHARS = 3500;

/** Caps on single fields, so the lines that are never dropped stay well under TELEGRAM_MAX_CHARS. */
const FIELD_CHARS = 200;
const JOB_NAME_CHARS = 100;

/** The disable reason when Telegram refuses the bot token or the bot is out of the chat. */
const UNAUTHORIZED = "telegram_unauthorized";

/** A run's state in the words of its GitHub check, which the message leads with. */
type TelegramStatus = "queued" | "running" | "success" | "failure" | "timed_out" | "cancelled" | "skipped" | "action_required";

const STATUS_WORD: Record<TelegramStatus, string> = {
	queued: S.checks.state.queued,
	running: S.checks.state.in_progress,
	success: S.checks.state.success,
	failure: S.checks.state.failure,
	timed_out: S.checks.state.timed_out,
	cancelled: S.checks.state.cancelled,
	skipped: S.checks.state.skipped,
	action_required: S.telegram.actionRequired,
};

/** Escapes text for Telegram's HTML parse mode. */
export function escapeTelegramHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** escapeTelegramHtml(s) in at most max characters, cut before escaping so no entity is split and ended with "...". */
function escapeWithin(s: string, max: number): string {
	const escaped = escapeTelegramHtml(s);
	if (escaped.length <= max) return escaped;
	let out = "";
	for (const ch of s) {
		const piece = escapeTelegramHtml(ch);
		if (out.length + piece.length > max - 3) break;
		out += piece;
	}
	return `${out}...`;
}

/** The bot API URL with its token masked, the only form of it fit for a log line or an error. */
export function redactTelegramUrl(url: string): string {
	return url.replace(/\/bot[^/]+\//, "/bot***/");
}

function statusOf(run: RunView, jobs: readonly JobView[]): TelegramStatus {
	switch (run.state) {
		case "gated":
			return "action_required";
		case "pending":
			return run.reason !== undefined ? "action_required" : "queued";
		case "received":
		case "queued":
			return "queued";
		case "running":
		case "verifying":
		case "rolling_back":
			return "running";
		case "success":
		case "failed": {
			const failed = jobs.filter((job) => job.state === "failed");
			if (failed.length > 0 && failed.every((job) => job.reason === "timeout")) return "timed_out";
			return run.state === "failed" || failed.length > 0 ? "failure" : "success";
		}
		case "cancelled":
		case "interrupted":
		case "superseded":
			return "cancelled";
		case "skipped":
			return "skipped";
	}
}

function jobLine(job: JobView): string {
	const state = jobToCheck(job);
	const word = S.checks.state[state.status === "completed" ? state.conclusion : state.status];
	const duration = job.durationMs !== undefined ? formatDuration(job.durationMs) : undefined;
	return S.slack.jobResult(escapeWithin(job.name, JOB_NAME_CHARS), word, duration);
}

/** The last TELEGRAM_TAIL_LINES lines, escaped, oldest dropped until they fit TELEGRAM_TAIL_CHARS. */
function tailLines(tail: readonly string[]): string[] {
	const lines = tail.slice(-TELEGRAM_TAIL_LINES).map((line) => escapeWithin(line, TELEGRAM_TAIL_CHARS));
	while (lines.length > 1 && joinedLength(lines) > TELEGRAM_TAIL_CHARS) lines.shift();
	return lines;
}

/** The length of lines joined with newlines. */
function joinedLength(lines: readonly string[]): number {
	return lines.reduce((n, line) => n + line.length, 0) + Math.max(0, lines.length - 1);
}

/**
 * The run as one Telegram HTML message: status word, repo and short SHA; ref,
 * trigger, target environment; one line per job; for a failed run its failed
 * job's log tail; a View logs link to its log job's stable link (runview.ts
 * logJob). Text from the repo or the agent is
 * escaped. Over TELEGRAM_MAX_CHARS the tail goes first, oldest line first,
 * then the last job lines, which a "... and N more jobs" line stands for.
 */
export function renderTelegram(run: RunView): { text: string; parseMode: "HTML" } {
	const jobs = run.jobs.filter((job) => job.name !== CONFIG_JOB);
	const status = statusOf(run, jobs);

	const head = [`<b>${STATUS_WORD[status]}</b> ${escapeWithin(run.repo, FIELD_CHARS)} <code>${escapeTelegramHtml(run.shortSha)}</code>`];
	const ref = run.ref?.replace(/^refs\/(heads|tags)\//, "");
	if (ref) head.push(escapeWithin(S.telegram.ref(ref), FIELD_CHARS));
	head.push(run.event === "pull_request" && run.prNumber !== undefined ? S.slack.pullRequest(run.prNumber) : S.telegram.push);
	if (run.target.startsWith("deploy:")) head.push(escapeWithin(S.telegram.environment(run.target.slice("deploy:".length)), FIELD_CHARS));
	if (status === "action_required") head.push(escapeTelegramHtml(S.slack.pending[run.reason ?? "fork_gated"]));

	const jobLines = jobs.map(jobLine);
	const failedTail = status === "failure" || status === "timed_out" ? run.jobs.find((job) => job.state === "failed" && job.tail?.length)?.tail : undefined;
	let tail = failedTail ? tailLines(failedTail) : [];

	const href = logJob(run)?.logLink;
	const link = href ? [`<a href="${escapeTelegramHtml(href)}">${S.telegram.viewLogs}</a>`] : [];

	const compose = (shown: readonly string[], tailShown: readonly string[]): string[] => [
		...head,
		...shown,
		...(tailShown.length > 0 ? [`<pre>${tailShown.join("\n")}</pre>`] : []),
		...link,
	];

	let lines = compose(jobLines, tail);
	while (tail.length > 0 && joinedLength(lines) > TELEGRAM_MAX_CHARS) {
		tail = tail.slice(1);
		lines = compose(jobLines, tail);
	}
	if (joinedLength(lines) > TELEGRAM_MAX_CHARS) {
		// Keep the most job lines that fit with the line standing for the rest.
		let used = joinedLength(compose([], []));
		let kept = 0;
		for (let k = 0; k <= jobLines.length; k++) {
			if (used + 1 + S.telegram.moreJobs(jobLines.length - k).length <= TELEGRAM_MAX_CHARS) kept = k;
			const next = jobLines[k];
			if (next === undefined) break;
			used += next.length + 1;
		}
		lines = compose([...jobLines.slice(0, kept), S.telegram.moreJobs(jobLines.length - kept)], []);
	}
	return { text: lines.join("\n"), parseMode: "HTML" };
}

/** The part of a Bot API reply the sink reads. */
interface TelegramReply {
	ok: boolean;
	result: unknown;
	description: string;
	/** Seconds to wait, sent with a 429. */
	retryAfter?: number;
}

/** POSTs body to the bot API method; a network failure throws telegram_unreachable naming the URL without its token. */
async function callTelegram(
	fetchFn: Fetcher,
	apiBase: string,
	token: string,
	method: string,
	body: Record<string, unknown>,
): Promise<{ status: number; reply: TelegramReply }> {
	const url = `${apiBase}/bot${token}/${method}`;
	let res: Response;
	try {
		res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	} catch {
		throw new HubError("telegram_unreachable", 502, `POST ${redactTelegramUrl(url)} failed`);
	}
	const raw: unknown = await res.json().catch(() => null);
	const description = field(raw, "description");
	const retryAfter = field(field(raw, "parameters"), "retry_after");
	return {
		status: res.status,
		reply: {
			ok: field(raw, "ok") === true,
			result: field(raw, "result"),
			description: typeof description === "string" ? description : "",
			...(typeof retryAfter === "number" ? { retryAfter } : {}),
		},
	};
}

/** The named field of a Bot API object, when value is an object. */
function field(value: unknown, name: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/** run with its failed job's tail read from the stored log when the update carries none and the log was uploaded. */
async function withTail(env: Env, run: RunView): Promise<RunView> {
	if (run.state !== "failed" && run.state !== "success") return run;
	const failed = run.jobs.find((job) => job.state === "failed");
	if (!failed || failed.tail?.length || failed.logs === "local" || !run.runId) return run;
	const tail = await getLogTail(env, run.runId, failed.name, TELEGRAM_TAIL_LINES);
	if (!tail?.length) return run;
	return { ...run, jobs: run.jobs.map((job) => (job === failed ? { ...job, tail } : job)) };
}

/** Sends the run to cfg.target with the bot token cfg.secret, then edits that message on every later update. */
export const telegramDeliverer: Deliverer = {
	async deliver(env, cfg, item): Promise<DeliveryResult> {
		if (!cfg.secret) return { kind: "fail", disable: UNAUTHORIZED };
		const t = tenantDb(env.DB, item.installationId);
		const { text, parseMode } = renderTelegram(await withTail(env, item.payload));
		const hash = await sha256Hex(text);
		const stored = await getSinkMessage(t, item.sinkId, item.runId);
		const messageId = stored?.externalId ?? null;
		if (stored?.lastHash === hash) return messageId ? { kind: "ok", externalId: messageId } : { kind: "ok" };

		const save = (msg: SinkMessage) => putSinkMessage(t, item.sinkId, item.runId, msg, (env.__TEST_CLOCK ?? systemClock).now());
		const body = {
			chat_id: cfg.target,
			...(messageId ? { message_id: Number(messageId) } : {}),
			text,
			parse_mode: parseMode,
			disable_web_page_preview: true,
		};
		let status: number;
		let reply: TelegramReply;
		try {
			({ status, reply } = await callTelegram(
				env.__TEST_FETCHER ?? defaultFetcher,
				env.TELEGRAM_API_BASE,
				cfg.secret,
				messageId ? "editMessageText" : "sendMessage",
				body,
			));
		} catch (err) {
			if (err instanceof HubError) return { kind: "retry" };
			throw err;
		}

		if (reply.ok) {
			const sent = field(reply.result, "message_id");
			const id = messageId ?? (typeof sent === "number" ? String(sent) : null);
			if (id === null) return { kind: "retry", httpStatus: status };
			await save({ externalId: id, lastHash: hash });
			return { kind: "ok", externalId: id };
		}
		if (status === 400 && messageId && reply.description.includes("message is not modified")) {
			await save({ externalId: messageId, lastHash: hash });
			return { kind: "ok", externalId: messageId };
		}
		if (status === 400 && messageId && reply.description.includes("message to edit not found")) {
			// Someone deleted the message: the next attempt sends a new one.
			await save({ externalId: null, lastHash: null });
			return { kind: "retry", afterMs: 0, httpStatus: status };
		}
		if (status === 429) {
			return reply.retryAfter !== undefined
				? { kind: "retry", afterMs: reply.retryAfter * 1000, httpStatus: status }
				: { kind: "retry", httpStatus: status };
		}
		if (status === 401 || status === 403) return { kind: "fail", httpStatus: status, disable: UNAUTHORIZED };
		if (status >= 400 && status < 500) return { kind: "fail", httpStatus: status };
		return { kind: "retry", httpStatus: status };
	},
};

export type TelegramValidation = { ok: true; botUsername: string; chatTitle: string } | { ok: false; code: "bad_token" | "chat_unreachable" };

/**
 * Checks a bot token and chat id before a sink is saved: getMe for the token,
 * getChat for the chat. Telegram failing (5xx or no answer) throws
 * telegram_unreachable rather than blaming the token or the chat.
 */
export async function validateTelegramConfig(fetchFn: Fetcher, apiBase: string, token: string, chatId: string): Promise<TelegramValidation> {
	const me = await callTelegram(fetchFn, apiBase, token, "getMe", {});
	if (me.status >= 500) throw new HubError("telegram_unreachable", 502, `getMe answered ${me.status}`);
	if (!me.reply.ok) return { ok: false, code: "bad_token" };
	const chat = await callTelegram(fetchFn, apiBase, token, "getChat", { chat_id: chatId });
	if (chat.status >= 500) throw new HubError("telegram_unreachable", 502, `getChat answered ${chat.status}`);
	if (!chat.reply.ok) return { ok: false, code: "chat_unreachable" };
	const username = field(me.reply.result, "username");
	const title = field(chat.reply.result, "title") ?? field(chat.reply.result, "username") ?? field(chat.reply.result, "first_name");
	return { ok: true, botUsername: typeof username === "string" ? username : "", chatTitle: typeof title === "string" ? title : chatId };
}

registerDeliverer("telegram", telegramDeliverer);
