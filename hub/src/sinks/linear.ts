// The Linear sink: one issue per deploy run, created on the run's first
// update and then edited in place. A successful deploy moves the issue to the
// configured completed state; a failed one assigns it and gets exactly one
// comment mentioning the assignee. Check runs are not mirrored. The API key
// (cfg.secret) only ever goes into the Authorization header: logs carry the
// sink, run, HTTP status and GraphQL error code, nothing else.

import { sha256Hex } from "../crypto";
import { getSinkMessage, putSinkMessage, type SinkMessage } from "../db/sinks";
import { tenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import { defaultFetcher, type Fetcher } from "../http";
import { logEvent, reportError } from "../observability";
import { formatDuration } from "../slack/badge";
import { S } from "../strings";
import { type Deliverer, type DeliveryResult, registerDeliverer } from "./deliverers";
import { logJob } from "./runview";
import type { RunState, RunView } from "./types";

/** Where a Linear sink files its issues, stored as JSON in cfg.target. */
export interface LinearTarget {
	teamId: string;
	teamKey: string;
	assigneeId?: string;
	assigneeName?: string;
	assigneeUrl?: string;
	completedStateId?: string;
}

/** The issue a sink keeps for a run, stored as JSON in sink_messages.external_id. */
export interface LinearExternalId {
	issueId: string;
	identifier?: string;
	url?: string;
	failureCommentId?: string;
}

export type LinearGqlResult<T> = { ok: true; data: T } | { ok: false; httpStatus: number; code?: string; resetAtMs?: number; message: string };

export const ISSUE_CREATE =
	"mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }";
export const ISSUE_UPDATE = "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }";
export const COMMENT_CREATE = "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }";

/** The disable reason when Linear refuses the API key. */
const UNAUTHORIZED = "linear_unauthorized";
/** The wait after a rate limit that names no reset time. */
const DEFAULT_RATE_LIMIT_MS = 60_000;

type LinearStatus = "queued" | "running" | "succeeded" | "failed" | "rolled back" | "cancelled";

function statusOf(state: RunState): LinearStatus {
	switch (state) {
		case "received":
		case "gated":
		case "pending":
		case "queued":
			return "queued";
		case "running":
		case "verifying":
			return "running";
		case "rolling_back":
			return "rolled back";
		case "success":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
		case "interrupted":
		case "superseded":
		case "skipped":
			return "cancelled";
	}
}

const TERMINAL: Record<LinearStatus, boolean> = {
	queued: false,
	running: false,
	"rolled back": false,
	succeeded: true,
	failed: true,
	cancelled: true,
};

function deployEnv(view: RunView): string {
	return view.target.startsWith("deploy:") ? view.target.slice("deploy:".length) : view.target;
}

/** Personal API keys go in the Authorization header as they are, without a Bearer prefix. */
export function linearAuthHeader(apiKey: string): string {
	return apiKey;
}

export function encodeLinearExternalId(x: LinearExternalId): string {
	return JSON.stringify(x);
}

function optionalString(o: object, name: string): string | undefined {
	const v: unknown = Reflect.get(o, name);
	return typeof v === "string" ? v : undefined;
}

/** The stored issue reference; null when s is missing or not one. */
export function decodeLinearExternalId(s: string | null | undefined): LinearExternalId | null {
	if (!s) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(s);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const issueId = optionalString(raw, "issueId");
	if (!issueId) return null;
	const out: LinearExternalId = { issueId };
	for (const key of ["identifier", "url", "failureCommentId"] as const) {
		const v = optionalString(raw, key);
		if (v !== undefined) out[key] = v;
	}
	return out;
}

function parseTarget(s: string): LinearTarget | null {
	let raw: unknown;
	try {
		raw = JSON.parse(s);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const teamId = optionalString(raw, "teamId");
	const teamKey = optionalString(raw, "teamKey");
	if (!teamId || !teamKey) return null;
	const out: LinearTarget = { teamId, teamKey };
	for (const key of ["assigneeId", "assigneeName", "assigneeUrl", "completedStateId"] as const) {
		const v = optionalString(raw, key);
		if (v !== undefined) out[key] = v;
	}
	return out;
}

/** The deploy run as an issue title and markdown description. */
export function renderLinear(view: RunView): { title: string; description: string; failed: boolean; succeeded: boolean } {
	const status = statusOf(view.state);
	const env = deployEnv(view);
	const lines = [
		S.linear.repo(view.repo),
		S.linear.environment(env),
		S.linear.commit(view.shortSha, `https://github.com/${view.repo}/commit/${view.sha}`),
		S.linear.actor(view.authorLogin),
	];
	if (view.startedAt !== undefined) lines.push(S.linear.started(new Date(view.startedAt).toISOString()));
	if (view.finishedAt !== undefined) lines.push(S.linear.finished(new Date(view.finishedAt).toISOString()));
	const duration = view.durationMs ?? (view.startedAt !== undefined && view.finishedAt !== undefined ? view.finishedAt - view.startedAt : undefined);
	if (duration !== undefined) lines.push(S.linear.duration(formatDuration(duration)));
	if (view.jobs.length > 0) {
		lines.push("", S.linear.steps, ...view.jobs.map((job) => S.linear.step(job.name, job.state)));
	}
	const log = logJob(view)?.logLink;
	if (log) lines.push("", S.linear.logs(log));
	return {
		title: S.linear.title(view.repo, env, view.shortSha, status),
		description: lines.join("\n"),
		failed: status === "failed",
		succeeded: status === "succeeded",
	};
}

function field(value: unknown, name: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

/** POSTs one GraphQL operation; never throws, and no result names the API key. */
export async function linearGraphql<T>(
	fetchFn: Fetcher,
	apiUrl: string,
	apiKey: string,
	query: string,
	variables: Record<string, unknown>,
): Promise<LinearGqlResult<T>> {
	let res: Response;
	try {
		res = await fetchFn(apiUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: linearAuthHeader(apiKey) },
			body: JSON.stringify({ query, variables }),
		});
	} catch {
		return { ok: false, httpStatus: 0, message: "linear unreachable" };
	}
	const reset = Number(res.headers.get("X-RateLimit-Requests-Reset"));
	const resetAtMs = res.headers.has("X-RateLimit-Requests-Reset") && Number.isFinite(reset) ? reset : undefined;
	const raw: unknown = await res.json().catch(() => null);
	const errors = field(raw, "errors");
	const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
	const code = field(field(first, "extensions"), "code");
	if (!res.ok || first !== undefined) {
		const message = field(first, "message");
		return {
			ok: false,
			httpStatus: res.status,
			...(typeof code === "string" ? { code } : {}),
			...(resetAtMs !== undefined ? { resetAtMs } : {}),
			message: typeof message === "string" ? message : `HTTP ${res.status}`,
		};
	}
	const data = field(raw, "data");
	if (data === undefined || data === null) return { ok: false, httpStatus: res.status, message: "no data" };
	return { ok: true, data: data as T };
}

/** What a failed Linear call means for the outbox. */
export function mapLinearError(r: Extract<LinearGqlResult<unknown>, { ok: false }>, now: number): DeliveryResult {
	if (r.httpStatus === 429 || r.code === "RATELIMITED") {
		const afterMs = r.resetAtMs !== undefined ? Math.max(1000, r.resetAtMs - now) : DEFAULT_RATE_LIMIT_MS;
		return { kind: "retry", afterMs, httpStatus: r.httpStatus };
	}
	if (r.httpStatus === 401 || r.httpStatus === 403 || r.code === "AUTHENTICATION_ERROR") {
		return { kind: "fail", httpStatus: r.httpStatus, disable: UNAUTHORIZED };
	}
	if (r.httpStatus === 0) return { kind: "retry" };
	if (r.httpStatus >= 500) return { kind: "retry", httpStatus: r.httpStatus };
	return { kind: "fail", httpStatus: r.httpStatus };
}

/** How a Linear sink config checked out; retry marks a refusal caused by a rate limit or an unreachable Linear. */
export type LinearValidation =
	| { ok: true; target: LinearTarget }
	| { ok: false; code: "bad_token" | "team_not_found" | "assignee_not_found" | "invalid"; retry?: true };

/** Asks who an API key belongs to; the cheapest call that proves the key works. */
export const LINEAR_VIEWER = "query { viewer { id } }";
const TEAM_BY_KEY = "query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }";
const USER_BY_EMAIL = "query($email: String!) { users(filter: { email: { eq: $email } }) { nodes { id name url } } }";
const COMPLETED_STATES = 'query($teamId: String!) { team(id: $teamId) { states(filter: { type: { eq: "completed" } }) { nodes { id position } } } }';

/** The nodes list at path in a GraphQL answer; empty when it is missing. */
function nodesAt(data: unknown, ...path: string[]): unknown[] {
	const list = field(
		path.reduce((v, name) => field(v, name), data),
		"nodes",
	);
	return Array.isArray(list) ? list : [];
}

function validationRefusal(r: Extract<LinearGqlResult<unknown>, { ok: false }>): LinearValidation {
	// The wait mapLinearError computes does not matter here, only what kind of failure it is.
	const mapped = mapLinearError(r, 0);
	if (mapped.kind === "retry") return { ok: false, code: "invalid", retry: true };
	return { ok: false, code: mapped.kind === "fail" && mapped.disable === UNAUTHORIZED ? "bad_token" : "invalid" };
}

/**
 * Checks a Linear API key, team key and optional assignee email before a
 * sink is saved and resolves them to the target the deliverer needs: the
 * viewer for the key, the team by key, the user by email, then the team's
 * completed state with the lowest position, if it has one. Any refusal
 * stops the check, so no partial target comes back.
 */
export async function validateLinearConfig(
	fetchFn: Fetcher,
	apiUrl: string,
	apiKey: string,
	teamKey: string,
	assigneeEmail?: string,
): Promise<LinearValidation> {
	const call = (query: string, variables: Record<string, unknown>) => linearGraphql<unknown>(fetchFn, apiUrl, apiKey, query, variables);
	const viewer = await call(LINEAR_VIEWER, {});
	if (!viewer.ok) return validationRefusal(viewer);

	const teams = await call(TEAM_BY_KEY, { key: teamKey });
	if (!teams.ok) return validationRefusal(teams);
	const teamId = field(nodesAt(teams.data, "teams")[0], "id");
	if (typeof teamId !== "string") return { ok: false, code: "team_not_found" };
	const target: LinearTarget = { teamId, teamKey };

	if (assigneeEmail !== undefined) {
		const users = await call(USER_BY_EMAIL, { email: assigneeEmail });
		if (!users.ok) return validationRefusal(users);
		const user = nodesAt(users.data, "users")[0];
		const assigneeId = field(user, "id");
		if (typeof assigneeId !== "string") return { ok: false, code: "assignee_not_found" };
		target.assigneeId = assigneeId;
		const name = field(user, "name");
		const url = field(user, "url");
		if (typeof name === "string") target.assigneeName = name;
		if (typeof url === "string") target.assigneeUrl = url;
	}

	const states = await call(COMPLETED_STATES, { teamId });
	if (!states.ok) return validationRefusal(states);
	let lowest: { id: string; position: number } | undefined;
	for (const node of nodesAt(states.data, "team", "states")) {
		const id = field(node, "id");
		const position = field(node, "position");
		if (typeof id === "string" && typeof position === "number" && (lowest === undefined || position < lowest.position)) lowest = { id, position };
	}
	if (lowest !== undefined) target.completedStateId = lowest.id;
	return { ok: true, target };
}

/** A mutation that came back with success false: Linear refused the input. */
function refused(httpStatus: number): Extract<LinearGqlResult<unknown>, { ok: false }> {
	return { ok: false, httpStatus, message: "success false" };
}

/** Creates the run's issue, then keeps it in step with every later update. */
export const linearDeliverer: Deliverer = {
	async deliver(env, cfg, item): Promise<DeliveryResult> {
		const view = item.payload;
		if (!view.target.startsWith("deploy:")) return { kind: "ok" };
		if (!cfg.secret) return { kind: "fail", disable: UNAUTHORIZED };
		const target = parseTarget(cfg.target);
		if (!target) return { kind: "fail" };
		const apiKey = cfg.secret;
		const clock = env.__TEST_CLOCK ?? systemClock;
		const fetchFn = env.__TEST_FETCHER ?? defaultFetcher;
		const t = tenantDb(env.DB, item.installationId);

		const { title, description, failed, succeeded } = renderLinear(view);
		const terminalState = TERMINAL[statusOf(view.state)] ? view.state : "open";
		const hash = await sha256Hex(`${title}\n${description}\n${terminalState}`);
		const stored = item.test ? null : await getSinkMessage(t, item.sinkId, item.runId);
		let ext = decodeLinearExternalId(stored?.externalId);
		if (stored?.lastHash === hash) return ext ? { kind: "ok", externalId: encodeLinearExternalId(ext) } : { kind: "ok" };

		const save = async (msg: SinkMessage): Promise<void> => {
			if (!item.test) await putSinkMessage(t, item.sinkId, item.runId, msg, clock.now());
		};
		const call = <T>(query: string, variables: Record<string, unknown>) => linearGraphql<T>(fetchFn, env.LINEAR_API_URL, apiKey, query, variables);
		const failWith = async (r: Extract<LinearGqlResult<unknown>, { ok: false }>): Promise<DeliveryResult> => {
			logEvent("linear_delivery_failed", {
				sink_id: item.sinkId,
				run_id: item.runId,
				http_status: r.httpStatus,
				...(r.code ? { code: r.code } : {}),
			});
			// Keep the issue already made, so the retry updates it rather than filing a second one.
			// A failed save is reported, not thrown: the outbox would turn the throw into a retry
			// and lose the mapped result.
			if (ext) {
				try {
					await save({ externalId: encodeLinearExternalId(ext), lastHash: null });
				} catch (err) {
					reportError(err, { installation_id: item.installationId, sink_id: item.sinkId, run_id: item.runId, event: "linear_issue_save_failed" });
				}
			}
			return mapLinearError(r, clock.now());
		};
		const assignee = failed && target.assigneeId ? { assigneeId: target.assigneeId } : {};
		const completed = succeeded && target.completedStateId ? { stateId: target.completedStateId } : {};

		let needsUpdate = true;
		if (!ext) {
			const created = await call<{ issueCreate?: { success: boolean; issue?: { id: string; identifier?: string; url?: string } } }>(ISSUE_CREATE, {
				input: { teamId: target.teamId, title, description, ...assignee },
			});
			if (!created.ok) return failWith(created);
			const issue = created.data.issueCreate?.issue;
			if (!created.data.issueCreate?.success || !issue?.id) return failWith(refused(200));
			ext = { issueId: issue.id, ...(issue.identifier ? { identifier: issue.identifier } : {}), ...(issue.url ? { url: issue.url } : {}) };
			needsUpdate = "stateId" in completed;
		}
		if (needsUpdate) {
			const updated = await call<{ issueUpdate?: { success: boolean } }>(ISSUE_UPDATE, {
				id: ext.issueId,
				input: { title, description, ...completed, ...assignee },
			});
			if (!updated.ok) return failWith(updated);
			if (!updated.data.issueUpdate?.success) return failWith(refused(200));
		}
		if (failed && !ext.failureCommentId) {
			const job = view.jobs.find((j) => j.state === "failed");
			const body = S.linear.failureComment(
				target.assigneeUrl ?? target.assigneeName ?? "",
				view.repo,
				deployEnv(view),
				view.shortSha,
				job ? (job.step ?? job.name) : view.state,
				logJob(view)?.logLink,
			);
			const commented = await call<{ commentCreate?: { success: boolean; comment?: { id: string } } }>(COMMENT_CREATE, {
				input: { issueId: ext.issueId, body },
			});
			if (!commented.ok) return failWith(commented);
			const id = commented.data.commentCreate?.comment?.id;
			if (!commented.data.commentCreate?.success || !id) return failWith(refused(200));
			ext = { ...ext, failureCommentId: id };
		}

		const externalId = encodeLinearExternalId(ext);
		try {
			await save({ externalId, lastHash: hash });
		} catch (err) {
			// Linear already has the issue; a retry would file it again.
			reportError(err, { installation_id: item.installationId, sink_id: item.sinkId, run_id: item.runId, event: "linear_issue_save_failed" });
		}
		return { kind: "ok", externalId };
	},
};

registerDeliverer("linear", linearDeliverer);
