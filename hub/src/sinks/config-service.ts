// Adding, listing, removing and test-firing the Telegram, webhook and Linear
// sinks of a repo, for the agent API (routes/sink-config.ts) and the Slack
// command. Secrets go in encrypted and never come back out: a webhook's
// generated secret is returned once by addSinkConfig, and listings carry a
// redacted target.

import { isRepoBound } from "../db/bindings";
import { hitIpRate } from "../db/ip-rate";
import { getRepoByFullName } from "../db/repos";
import { createSinkConfig, deleteSinkConfig, getSinkConfigWithSecret, listRepoSinkConfigs, type SinkConfigRow, type SinkKind } from "../db/sinks";
import type { TenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { defaultFetcher } from "../http";
import { logEvent } from "../observability";
import { quotaLimit } from "../quotas";
import { S } from "../strings";
import { ulid } from "../ulid";
import { type DeliveryResult, delivererFor } from "./deliverers";
import { LINEAR_VIEWER, linearGraphql, mapLinearError, validateLinearConfig } from "./linear";
import { validateTelegramConfig } from "./telegram";
import type { RunView } from "./types";
import { generateWebhookSecret, validateWebhookUrl } from "./webhook";

export type SinkConfigInput =
	| { kind: "telegram"; repo: string; botToken: string; chatId: string; label?: string }
	| { kind: "webhook"; repo: string; url: string; label?: string }
	| { kind: "linear"; repo: string; apiKey: string; teamKey: string; assigneeEmail?: string; label?: string };

export type SinkConfigErrorCode =
	| "invalid_repo"
	| "repo_not_bound"
	| "bad_token"
	| "chat_unreachable"
	| "not_https"
	| "private_host"
	| "self"
	| "invalid"
	| "limit_reached"
	| "team_not_found"
	| "assignee_not_found";

/** A refused add, list or remove; message is safe to show the user and never holds the input's secrets. */
export class SinkConfigError extends Error {
	constructor(
		public code: SinkConfigErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SinkConfigError";
	}
}

/** The installation already added or removed sinkConfigWritesPerHour configs this hour. */
export class SinkQuotaError extends HubError {
	constructor(public retryAfterSeconds: number) {
		super("quota_exceeded", 429);
	}
}

/** Who asks: an agent by agent_id, or a Slack user as `<team>:<user>`. */
export interface SinkActor {
	type: "agent" | "slack_user";
	id: string;
}

/** A sink config as it is shown: no secret, and the target redacted. */
export interface PublicSinkConfig {
	id: string;
	kind: SinkKind;
	repo: string;
	label: string | null;
	/**
	 * `chat <chat id>` for Telegram; the webhook URL's origin and at most 24
	 * characters of its path, without the query; the team key and assignee
	 * name for Linear, without the team id or any key.
	 */
	target: string | { teamKey: string; assigneeName?: string };
	created_at: string;
	disabled_at: string | null;
	/** Why the hub disabled the sink; null while it is enabled. */
	last_error: string | null;
}

export const MAX_SINKS_PER_REPO = 10;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BOT_TOKEN = /^\d+:[A-Za-z0-9_-]+$/;
const CHAT_ID = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;
/** A Linear team key, as in ENG for ENG-123. */
export const LINEAR_TEAM_KEY = /^[A-Z][A-Z0-9]{0,9}$/;
const LABEL_MAX_CHARS = 64;
const TARGET_PATH_CHARS = 24;
const HOUR_MS = 3_600_000;

function refuse(code: SinkConfigErrorCode): SinkConfigError {
	const message = S.sinks.errors[code];
	return new SinkConfigError(code, typeof message === "string" ? message : message(MAX_SINKS_PER_REPO));
}

/** The canonical `owner/name` of a repo the installation has; refuses one in another form. */
async function canonicalRepo(t: TenantDb, repo: string): Promise<{ repoId: number; fullName: string } | null> {
	if (!REPO.test(repo)) throw refuse("invalid_repo");
	const row = await getRepoByFullName(t, repo);
	return row ? { repoId: row.repo_id, fullName: row.full_name } : null;
}

/** Counts one add or remove against the installation's hourly quota; throws SinkQuotaError past it. */
async function admitWrite(env: Env, t: TenantDb): Promise<void> {
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const rate = await hitIpRate(env.DB, `sinkcfg:${t.installationId}`, quotaLimit(env, "sinkConfigWritesPerHour"), HOUR_MS, now);
	if (!rate.ok) throw new SinkQuotaError(rate.retryAfterSeconds);
}

function toPublic(cfg: SinkConfigRow): PublicSinkConfig {
	let target: PublicSinkConfig["target"];
	if (cfg.kind === "telegram") {
		target = S.sinks.telegramTarget(cfg.target);
	} else if (cfg.kind === "linear") {
		// A row that does not parse still lists, so it can be seen and removed.
		let linear: { teamKey?: unknown; assigneeName?: unknown };
		try {
			linear = JSON.parse(cfg.target) ?? {};
		} catch {
			linear = {};
		}
		const teamKey = typeof linear.teamKey === "string" ? linear.teamKey : S.sinks.linearUnknownTeamKey;
		target = typeof linear.assigneeName === "string" ? { teamKey, assigneeName: linear.assigneeName } : { teamKey };
	} else {
		const url = new URL(cfg.target);
		const path = url.pathname.length > TARGET_PATH_CHARS ? `${url.pathname.slice(0, TARGET_PATH_CHARS)}...` : url.pathname;
		target = `${url.protocol}//${url.host}${path}`;
	}
	return {
		id: cfg.id,
		kind: cfg.kind,
		repo: cfg.repo,
		label: cfg.label,
		target,
		created_at: new Date(cfg.createdAt).toISOString(),
		disabled_at: cfg.disabledAt === null ? null : new Date(cfg.disabledAt).toISOString(),
		last_error: cfg.disabledReason,
	};
}

function audit(event: string, t: TenantDb, actor: SinkActor, cfg: SinkConfigRow, extra: Record<string, string> = {}): void {
	logEvent(event, { installation_id: t.installationId, sink_id: cfg.id, kind: cfg.kind, repo: cfg.repo, actor: `${actor.type}:${actor.id}`, ...extra });
}

/**
 * Validates input against its provider and stores it for a repo the
 * installation has bound to an agent. A webhook gets a new signing secret,
 * returned here once and never again. Every call counts against
 * sinkConfigWritesPerHour. Telegram answering 5xx throws telegram_unreachable;
 * Linear rate limiting or answering 5xx refuses with invalid and a retry hint.
 */
export async function addSinkConfig(
	env: Env,
	t: TenantDb,
	actor: SinkActor,
	input: SinkConfigInput,
): Promise<{ sink: PublicSinkConfig; generatedSecret?: string }> {
	await admitWrite(env, t);
	const repo = await canonicalRepo(t, input.repo);
	if (!repo || !(await isRepoBound(t, repo.repoId))) throw refuse("repo_not_bound");

	const label = input.label?.trim() || null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what the label must not hold.
	if (label !== null && (label.length > LABEL_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(label))) throw refuse("invalid");

	if ((await listRepoSinkConfigs(t, repo.fullName)).length >= MAX_SINKS_PER_REPO) throw refuse("limit_reached");

	let target: string;
	let secret: string;
	let generatedSecret: string | undefined;
	if (input.kind === "telegram") {
		if (!BOT_TOKEN.test(input.botToken)) throw refuse("bad_token");
		if (!CHAT_ID.test(input.chatId)) throw refuse("chat_unreachable");
		const check = await validateTelegramConfig(env.__TEST_FETCHER ?? defaultFetcher, env.TELEGRAM_API_BASE, input.botToken, input.chatId);
		if (!check.ok) throw refuse(check.code);
		target = input.chatId;
		secret = input.botToken;
	} else if (input.kind === "webhook") {
		const check = validateWebhookUrl(input.url, new URL(env.HUB_ORIGIN).hostname);
		if (!check.ok) throw refuse(check.code);
		target = check.url.toString();
		secret = generatedSecret = generateWebhookSecret();
	} else {
		if (!LINEAR_TEAM_KEY.test(input.teamKey)) throw refuse("team_not_found");
		const check = await validateLinearConfig(env.__TEST_FETCHER ?? defaultFetcher, env.LINEAR_API_URL, input.apiKey, input.teamKey, input.assigneeEmail);
		if (!check.ok) {
			if (check.retry) throw new SinkConfigError(check.code, S.sinks.linearUnavailable);
			throw check.code === "bad_token" ? new SinkConfigError("bad_token", S.sinks.linearBadToken) : refuse(check.code);
		}
		target = JSON.stringify(check.target);
		secret = input.apiKey;
	}

	const createdBy = actor.type === "agent" ? `agent:${actor.id}` : `slack:${actor.id}`;
	const cfg = await createSinkConfig(env, t, { kind: input.kind, repo: repo.fullName, target, secret, label, createdBy });
	audit("sink_config.added", t, actor, cfg);
	return generatedSecret === undefined ? { sink: toPublic(cfg) } : { sink: toPublic(cfg), generatedSecret };
}

/** Every config of the repo, disabled ones too, oldest first. */
export async function listSinkConfigsForRepo(t: TenantDb, repo: string): Promise<PublicSinkConfig[]> {
	const found = await canonicalRepo(t, repo);
	return found ? (await listRepoSinkConfigs(t, found.fullName)).map(toPublic) : [];
}

/**
 * Deletes the config and its per-run messages; false when the installation
 * has no such config. Queued outbox items for it are dropped on their next
 * attempt. Counts against sinkConfigWritesPerHour.
 */
export async function removeSinkConfig(env: Env, t: TenantDb, actor: SinkActor, id: string): Promise<boolean> {
	await admitWrite(env, t);
	const cfg = await deleteSinkConfig(t, id);
	if (!cfg) return false;
	audit("sink_config.removed", t, actor, cfg);
	return true;
}

/**
 * Sends a synthetic successful run to the config, disabled or not, straight
 * through its deliverer: no outbox, no retry, and no sink_messages or
 * sink_deliveries rows. A Linear config only asks Linear who the key
 * belongs to, so no test issue is filed. Throws not_found when the
 * installation has no such config.
 */
export async function sendTestDelivery(env: Env, t: TenantDb, actor: SinkActor, id: string): Promise<DeliveryResult> {
	const cfg = await getSinkConfigWithSecret(env, t, id);
	if (!cfg) throw new HubError("not_found", 404);
	const deliverer = delivererFor(cfg.kind);
	if (!deliverer) throw new HubError("sink_deliverer_missing", 500, `no deliverer for sink kind ${cfg.kind}`);

	const now = (env.__TEST_CLOCK ?? systemClock).now();
	if (cfg.kind === "linear") {
		const viewer = cfg.secret === null ? null : await linearGraphql(env.__TEST_FETCHER ?? defaultFetcher, env.LINEAR_API_URL, cfg.secret, LINEAR_VIEWER, {});
		const result: DeliveryResult = viewer === null ? { kind: "fail" } : viewer.ok ? { kind: "ok" } : mapLinearError(viewer, now);
		audit("sink_config.tested", t, actor, cfg, { result: result.kind });
		return result;
	}
	const runId = `test_${ulid(now)}`;
	const run: RunView = {
		installationId: t.installationId,
		repoId: 0,
		repo: cfg.repo,
		triggerId: runId,
		sha: "0".repeat(40),
		shortSha: "0000000",
		event: "push",
		target: "checks",
		state: "success",
		commitTitle: S.sinks.testCommitTitle,
		authorLogin: "hookci",
		jobs: [],
	};
	let result: DeliveryResult;
	try {
		result = await deliverer.deliver(env, cfg, { installationId: t.installationId, sinkId: cfg.id, runId, terminal: true, payload: run, enqueuedAt: now, deliveryId: ulid(now), test: true }, 1);
	} catch (err) {
		// Only the error's code or class: a provider error message may carry the target URL or token.
		const error = err instanceof HubError ? err.code : err instanceof Error ? err.name : "unknown";
		logEvent("sink_test_delivery_error", { installation_id: t.installationId, sink_id: cfg.id, error });
		result = { kind: "retry" };
	}
	audit("sink_config.tested", t, actor, cfg, { result: result.kind });
	return result;
}
