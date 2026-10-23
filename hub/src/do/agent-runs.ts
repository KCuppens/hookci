// The run lifecycle on the AgentDO: triggers in from the Worker, deduped by
// idempotency key, capped per day, superseding older work on the same pull
// request or branch, then the agent's accepted/rejected/job/event frames into
// D1, fetch tokens out, and every change fanned out to the sinks.
//
// A run's D1 run_id is its trigger_id until the agent accepts it and names
// the run; the triggers table remembers which run_id each trigger became.

import { aggregateFor } from "../checks/map";
import { getAgent } from "../db/agents";
import { insertAnnotations, validAnnotations } from "../db/annotations";
import { type BindingTarget, deployEnv, getBinding } from "../db/bindings";
import {
	acceptRun,
	insertRun,
	listJobNames,
	markJobLogsLocal,
	markRunPending,
	type RunPatch,
	setRunSlackOverride,
	supersedeRun,
	updateRunState,
	upsertJob,
} from "../db/runs";
import { chainDeploys, recordDeployReply } from "../deploy/chain";
import { onDeployEvent } from "../deploy/render";
import { HubError } from "../errors";
import { GitHubClient } from "../github/client";
import type { HubTrigger } from "../github/normalize";
import { defaultFetcher } from "../http";
import { logEvent, reportError } from "../observability";
import type { TrustRefusal } from "../policy/trust";
import type { Event as EventFrame, Interrupt } from "../protocol";
import { checkQuota, QUOTAS } from "../quotas";
import { fanOut, type SinkHost, sinksFor, sinksForRun } from "../sinks";
import { loadRunView } from "../sinks/runview";
import { pruneStoredTails, type SlackFoldRequest, slackSinkFactory } from "../sinks/slack";
import type { Annotation, RunView, Sink } from "../sinks/types";
import { TERMINAL as RUN_ENDED } from "../slack/badge";
import { S } from "../strings";
import { ulid } from "../ulid";
import type { TriggerRequest } from "../webhook/route";
import type { AgentDO, OutboundFrame } from "./agent";
import { registerFrameHandler } from "./agent-frames";
import { registerAlarmTask, registerOfflineHook } from "./agent-hooks";
import { ALARM_INTERVAL_MS, CLOSE } from "./agent-protocol";
import { registerDoRoute } from "./agent-routes";

/** A trigger still `sent` this long while the agent is offline leaves its run pending with agent_offline. */
export const OFFLINE_PENDING_MS = 10 * 60_000;
/** A finished trigger row, and a failed job's stored tail, is kept this long. */
export const TRIGGER_RETENTION_MS = 14 * 24 * 60 * 60_000;

type TriggerState = "sent" | "gated" | "accepted" | "rejected" | "superseded" | "done";

type TriggerRow = {
	trigger_id: string;
	idem_key: string;
	repo_id: number;
	pr_number: number | null;
	ref: string;
	target: BindingTarget;
	sha: string;
	run_id: string | null;
	state: TriggerState;
	outbox_seq: number | null;
	created_at: number;
};

/** DO migration step: the triggers table. ref is kept so a push supersedes only work on its own branch. */
export function createTriggersTable(sql: SqlStorage): void {
	sql.exec(`CREATE TABLE triggers (
		trigger_id TEXT PRIMARY KEY,
		idem_key TEXT NOT NULL UNIQUE,
		repo_id INTEGER NOT NULL,
		pr_number INTEGER,
		ref TEXT NOT NULL,
		target TEXT NOT NULL,
		sha TEXT NOT NULL,
		run_id TEXT,
		state TEXT NOT NULL CHECK (state IN ('sent', 'accepted', 'rejected', 'superseded', 'done')),
		outbox_seq INTEGER,
		created_at INTEGER NOT NULL
	)`);
	sql.exec("CREATE INDEX triggers_run_id ON triggers (run_id)");
	sql.exec("CREATE INDEX triggers_state ON triggers (state, created_at)");
}

/** DO migration step: triggers may wait as `gated` until someone approves a fork run. */
export function allowGatedTriggers(sql: SqlStorage): void {
	sql.exec(`CREATE TABLE triggers_new (
		trigger_id TEXT PRIMARY KEY,
		idem_key TEXT NOT NULL UNIQUE,
		repo_id INTEGER NOT NULL,
		pr_number INTEGER,
		ref TEXT NOT NULL,
		target TEXT NOT NULL,
		sha TEXT NOT NULL,
		run_id TEXT,
		state TEXT NOT NULL CHECK (state IN ('sent', 'gated', 'accepted', 'rejected', 'superseded', 'done')),
		outbox_seq INTEGER,
		created_at INTEGER NOT NULL
	)`);
	sql.exec("INSERT INTO triggers_new SELECT * FROM triggers");
	sql.exec("DROP TABLE triggers");
	sql.exec("ALTER TABLE triggers_new RENAME TO triggers");
	sql.exec("CREATE INDEX triggers_run_id ON triggers (run_id)");
	sql.exec("CREATE INDEX triggers_state ON triggers (state, created_at)");
}

/** Same key, same run: a webhook delivered twice dispatches once; a retry with a new attempt dispatches again. */
export function idemKey(trig: Pick<TriggerRequest, "repoId" | "sha" | "event" | "target" | "attempt">): string {
	return [trig.repoId, trig.sha, trig.event, deployEnv(trig.target) ?? "", trig.attempt ?? 1].join(":");
}

// Run states after which the agent sends nothing more for the run.
const TERMINAL: Record<EventFrame["state"], boolean> = {
	queued: false,
	running: false,
	verifying: false,
	rolling_back: false,
	success: true,
	failed: true,
	cancelled: true,
	skipped: true,
	superseded: true,
	interrupted: true,
};

function triggerById(dob: AgentDO, triggerId: string): TriggerRow {
	const row = dob.sql.exec<TriggerRow>("SELECT * FROM triggers WHERE trigger_id = ?", triggerId).toArray()[0];
	if (!row) {
		logEvent("tenant_denied", { installation_id: dob.installationId, agent_id: dob.agentId, trigger_id: triggerId, reason: "unknown_trigger" });
		throw new HubError("unknown_trigger", 404, `no trigger ${triggerId} on this agent`);
	}
	return row;
}

/** The newest trigger the agent accepted as runId (a deploy retry reuses the run id); null when this agent never ran it. */
function triggerByRun(dob: AgentDO, runId: string): TriggerRow | null {
	return dob.sql.exec<TriggerRow>("SELECT * FROM triggers WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", runId).toArray()[0] ?? null;
}

/**
 * A deploy trigger this agent has not answered yet; its checks read GitHub before the agent accepts it, so the agent asks for a
 * token by trigger id. A trigger superseded before its ack arrived still counts: the agent may already be checking it, and a
 * refusal is an auth_failed frame. Once accepted it has a run_id and the agent asks by that instead.
 */
function sentDeployTrigger(dob: AgentDO, triggerId: string): TriggerRow | null {
	const row = dob.sql
		.exec<TriggerRow>("SELECT * FROM triggers WHERE trigger_id = ? AND (state = 'sent' OR (state = 'superseded' AND run_id IS NULL))", triggerId)
		.toArray()[0];
	return row !== undefined && deployEnv(row.target) != null ? row : null;
}

function ownedRun(dob: AgentDO, runId: string): TriggerRow {
	const row = triggerByRun(dob, runId);
	if (!row) {
		logEvent("tenant_denied", { installation_id: dob.installationId, agent_id: dob.agentId, run_id: runId, reason: "unknown_run" });
		throw new HubError("unknown_run", 404, `no run ${runId} on this agent`);
	}
	return row;
}

/** Loads the run and hands it to fn for every sink of its repo. */
async function fanOutRun(dob: AgentDO, runId: string, fn: (sink: Sink, run: RunView) => Promise<void>): Promise<void> {
	await fanOutView(dob, { runId }, fn);
}

/** fanOutRun for the run of triggerId, whether or not the agent has renamed it yet. */
async function fanOutTrigger(dob: AgentDO, triggerId: string, fn: (sink: Sink, run: RunView) => Promise<void>): Promise<void> {
	await fanOutView(dob, { triggerId }, fn);
}

async function fanOutView(
	dob: AgentDO,
	key: { runId: string } | { triggerId: string },
	fn: (sink: Sink, run: RunView) => Promise<void>,
): Promise<void> {
	const run = await loadRunView(dob.bindings, dob.installationId, key);
	if (!run) return;
	const sinks = await sinksForRun(dob.bindings, dob.installationId, run.repo, sinkHost(dob));
	fanOut(dob.state, sinks, (sink) => fn(sink, run));
}

/** The DO's agent, storage and clock, so sinks queue their work in it. */
function sinkHost(dob: AgentDO): SinkHost {
	return { agentId: dob.agentId, storage: dob.state.storage, now: () => dob.clock.now() };
}

const runUpdate = (sink: Sink, run: RunView) => sink.onRunUpdate(run);

/**
 * Marks the older triggers trig replaces superseded and returns them with
 * the interrupts to send. Checks work on the same pull request (or, for a
 * push, the same branch) is replaced whether sent or running. Deploys are
 * only replaced while the agent has not received them; a running deploy is
 * never interrupted. A retry (attempt > 1) replaces only earlier attempts of
 * its own commit: retrying an older commit must not drop a newer one.
 */
function supersede(dob: AgentDO, own: TriggerRow, attempt: number): { replaced: TriggerRow[]; interrupts: OutboundFrame[] } {
	const scope = own.pr_number === null ? "pr_number IS NULL AND ref = ?" : "pr_number = ?";
	const older = dob.sql
		.exec<TriggerRow>(
			`SELECT * FROM triggers WHERE trigger_id != ? AND repo_id = ? AND target = ? AND state IN ('sent', 'gated', 'accepted')
			${own.target === "checks" ? `AND ${scope}` : ""} ${attempt > 1 ? "AND sha = ?" : ""} ORDER BY created_at`,
			...[
				own.trigger_id,
				own.repo_id,
				own.target,
				...(own.target === "checks" ? [own.pr_number ?? own.ref] : []),
				...(attempt > 1 ? [own.sha] : []),
			],
		)
		.toArray();
	const replaced: TriggerRow[] = [];
	const interrupts: OutboundFrame[] = [];
	for (const row of older) {
		const unsent =
			row.state === "sent" &&
			(row.outbox_seq === null || dob.sql.exec("DELETE FROM outbox WHERE seq = ? RETURNING seq", row.outbox_seq).toArray().length > 0);
		if (own.target !== "checks" && !unsent) continue;
		if (!unsent) {
			interrupts.push(
				row.run_id === null
					? { v: 1, type: "interrupt", trigger_id: row.trigger_id, reason: "superseded" }
					: { v: 1, type: "interrupt", run_id: row.run_id, reason: "superseded" },
			);
		}
		dob.sql.exec("UPDATE triggers SET state = 'superseded' WHERE trigger_id = ?", row.trigger_id);
		replaced.push(row);
	}
	return { replaced, interrupts };
}

function newRun(dob: AgentDO, trig: HubTrigger & { attempt?: number }, triggerId: string, state: string, reason: string | null) {
	return {
		run_id: triggerId,
		repo_id: trig.repoId,
		sha: trig.sha,
		ref: trig.ref,
		event: trig.event,
		pr_number: trig.pr?.number ?? null,
		env: deployEnv(trig.target),
		attempt: trig.attempt ?? 1,
		trigger_id: triggerId,
		agent_id: dob.agentId,
		state,
		reason,
		author_login: trig.authorLogin,
		commit_title: trig.commitTitle,
		started_at: null,
		finished_at: null,
		duration_ms: null,
		log_key: null,
	};
}

function insertTrigger(dob: AgentDO, trig: HubTrigger & { attempt?: number; triggerId?: string }, state: TriggerState, now: number): TriggerRow | undefined {
	return dob.sql
		.exec<TriggerRow>(
			`INSERT INTO triggers (trigger_id, idem_key, repo_id, pr_number, ref, target, sha, state, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (idem_key) DO NOTHING RETURNING *`,
			trig.triggerId ?? ulid(now),
			idemKey(trig),
			trig.repoId,
			trig.pr?.number ?? null,
			trig.ref,
			trig.target,
			trig.sha,
			state,
			now,
		)
		.toArray()[0];
}

/** Records a fork run that waits for approval (or never runs) and supersedes older work; the agent hears nothing. */
async function onGate(dob: AgentDO, req: Request): Promise<Response> {
	const agentId = req.headers.get("x-hookci-agent-id");
	const trig = await req.json<HubTrigger & { reason: "fork_gated" | "fork_never"; trustRefused?: TrustRefusal | null }>();
	const trustRefused = trig.trustRefused ?? null;
	if (
		!agentId ||
		(trig.reason !== "fork_gated" && trig.reason !== "fork_never") ||
		(trustRefused !== null && trustRefused !== "shared_hub" && trustRefused !== "deploy_bindings")
	) {
		return Response.json({ error: "bad_request" }, { status: 400 });
	}
	if (!dob.adopt(agentId, trig.installationId)) return Response.json({ error: "agent_mismatch" }, { status: 409 });

	const now = dob.clock.now();
	// A fork_never run can never be approved, so its trigger is done at once.
	const own = insertTrigger(dob, trig, trig.reason === "fork_gated" ? "gated" : "done", now);
	if (!own) {
		const existing = dob.sql.exec<{ trigger_id: string }>("SELECT trigger_id FROM triggers WHERE idem_key = ?", idemKey(trig)).toArray()[0];
		return Response.json({ duplicate: true, trigger_id: existing?.trigger_id });
	}
	const triggerId = own.trigger_id;
	const t = dob.tenant();
	try {
		await insertRun(t, { ...newRun(dob, trig, triggerId, "gated", trig.reason), trust_refused: trustRefused }, now);
	} catch (err) {
		dob.sql.exec("DELETE FROM triggers WHERE trigger_id = ?", triggerId);
		throw err;
	}

	const { replaced, interrupts } = supersede(dob, own, 1);
	for (const interrupt of interrupts) await dob.send(interrupt);
	for (const row of replaced) await supersedeRun(t, row.trigger_id, now);
	await Promise.all([
		fanOutRun(dob, triggerId, (sink, run) => sink.onRunUpdate({ ...run, authorEmail: trig.authorEmail })),
		...replaced.map((row) => fanOutTrigger(dob, row.trigger_id, runUpdate)),
	]);
	return Response.json({ trigger_id: triggerId }, { status: 202 });
}

async function onTrigger(dob: AgentDO, req: Request): Promise<Response> {
	const agentId = req.headers.get("x-hookci-agent-id");
	const trig = await req.json<TriggerRequest>();
	if (!agentId || (trig.trust !== "trusted" && trig.trust !== "untrusted")) return Response.json({ error: "bad_request" }, { status: 400 });
	if (!dob.adopt(agentId, trig.installationId)) return Response.json({ error: "agent_mismatch" }, { status: 409 });

	const now = dob.clock.now();
	const attempt = trig.attempt ?? 1;
	// An approval releases the gated trigger of runId, once and only for the commit it was gated on.
	const own =
		trig.runId === undefined
			? insertTrigger(dob, trig, "sent", now)
			: dob.sql
					.exec<TriggerRow>("UPDATE triggers SET state = 'sent' WHERE trigger_id = ? AND state = 'gated' AND sha = ? RETURNING *", trig.runId, trig.sha)
					.toArray()[0];
	if (!own && trig.runId !== undefined) {
		const row = dob.sql.exec<TriggerRow>("SELECT * FROM triggers WHERE trigger_id = ?", trig.runId).toArray()[0];
		const stale = row !== undefined && (row.sha !== trig.sha || row.state === "superseded");
		return Response.json({ error: stale ? "fork_approval_stale" : "fork_approval_used" }, { status: 409 });
	}
	if (!own) return Response.json({ duplicate: true });
	const triggerId = own.trigger_id;

	const t = dob.tenant();
	let capped: boolean;
	const day = new Date(now).toISOString().slice(0, 10);
	let counted = false;
	try {
		const counter = await t.first<{ runs: number }>(
			`INSERT INTO daily_counters (installation_id, day, runs) VALUES (?1, ?2, 1)
			ON CONFLICT (installation_id, day) DO UPDATE SET runs = runs + 1 RETURNING runs`,
			day,
		);
		counted = true;
		capped = !checkQuota(dob.bindings, "runsPerDay", counter?.runs ?? 0);
		const state = capped ? "pending" : "received";
		const reason = capped ? "daily_cap" : null;
		if (trig.runId === undefined) await insertRun(t, newRun(dob, trig, triggerId, state, reason), now);
		else await updateRunState(t, triggerId, state, { reason });
	} catch (err) {
		// Free the idempotency key (or the approval) so the webhook or approver can try again, and give back its count.
		if (trig.runId === undefined) dob.sql.exec("DELETE FROM triggers WHERE trigger_id = ?", triggerId);
		else dob.sql.exec("UPDATE triggers SET state = 'gated' WHERE trigger_id = ?", triggerId);
		if (counted) {
			await t
				.run("UPDATE daily_counters SET runs = runs - 1 WHERE installation_id = ?1 AND day = ?2 AND runs > 0", day)
				.catch((undo: unknown) => reportError(undo, { installation_id: dob.installationId ?? 0, op: "daily_counter_undo" }));
		}
		throw err;
	}

	if (capped) {
		dob.sql.exec("UPDATE triggers SET state = 'done' WHERE trigger_id = ?", triggerId);
		// Runs do not store the commit author's email; only the trigger's own fan-out knows it.
		await fanOutRun(dob, triggerId, (sink, run) => sink.onRunUpdate({ ...run, authorEmail: trig.authorEmail, approvedBy: trig.approvedBy }));
		return Response.json({ trigger_id: triggerId }, { status: 202 });
	}

	// A newer trigger may have replaced this one while D1 was awaited.
	const stillSent = triggerById(dob, triggerId).state === "sent";
	const { replaced, interrupts } = stillSent ? supersede(dob, own, attempt) : { replaced: [], interrupts: [] };
	if (stillSent) {
		const env = deployEnv(trig.target);
		const seq = await dob.send({
			v: 1,
			type: "trigger",
			trigger_id: triggerId,
			repo: trig.repo,
			sha: trig.sha,
			ref: trig.ref,
			event: trig.retry ? "retry" : trig.event,
			...(env === null ? {} : { env }),
			pr: trig.pr && {
				number: trig.pr.number,
				head_ref: trig.pr.headRef,
				head_repo_full_name: trig.pr.headRepoFullName,
				fork: trig.pr.fork,
				base_ref: trig.pr.baseRef,
			},
			default_branch: trig.defaultBranch,
			base_sha: trig.baseSha,
			attempt,
			trust: trig.trust,
		});
		dob.sql.exec("UPDATE triggers SET outbox_seq = ? WHERE trigger_id = ?", seq, triggerId);
	}
	for (const interrupt of interrupts) await dob.send(interrupt);

	if (stillSent) await updateRunState(t, triggerId, "queued");
	else await supersedeRun(t, triggerId, now);
	for (const row of replaced) await supersedeRun(t, row.trigger_id, now);
	await Promise.all([
		fanOutTrigger(dob, triggerId, (sink, run) => sink.onRunUpdate({ ...run, authorEmail: trig.authorEmail, approvedBy: trig.approvedBy })),
		...replaced.map((row) => fanOutTrigger(dob, row.trigger_id, runUpdate)),
	]);

	if (stillSent && !dob.isOnline() && (await dob.state.storage.getAlarm()) === null) {
		await dob.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
	}
	return Response.json({ trigger_id: triggerId }, { status: 202 });
}

/** Queues an interrupt with reason for every run the agent accepted and has not finished. */
async function interruptAccepted(dob: AgentDO, reason: Interrupt["reason"]): Promise<void> {
	const running = dob.sql.exec<{ run_id: string }>("SELECT run_id FROM triggers WHERE state = 'accepted' AND run_id IS NOT NULL ORDER BY created_at");
	for (const { run_id } of running.toArray()) await dob.send({ v: 1, type: "interrupt", run_id, reason });
}

/** The agent's credential was rotated: stop its runs and drop the socket opened with the old credential. */
async function onRepair(dob: AgentDO): Promise<Response> {
	await interruptAccepted(dob, "repair");
	dob.disconnect(CLOSE.replaced, "repair");
	return Response.json({ ok: true });
}

/**
 * Renders the deploys of a checks run this agent ran into its Slack message,
 * for a deploy on another agent: in this DO's queue for the run, so the
 * render waits behind the run's own and none lands out of order.
 */
async function onSlackFold(dob: AgentDO, req: Request): Promise<Response> {
	const agentId = req.headers.get("x-hookci-agent-id");
	const fold = await req.json<SlackFoldRequest>();
	if (!agentId || typeof fold.checksRunId !== "string" || typeof fold.checksTriggerId !== "string") {
		return Response.json({ error: "bad_request" }, { status: 400 });
	}
	if (!dob.adopt(agentId, fold.installationId)) return Response.json({ error: "agent_mismatch" }, { status: 409 });
	await slackSinkFactory(dob.bindings, dob.installationId, sinkHost(dob)).foldInto(fold.checksRunId, fold.checksTriggerId, fold.deploy);
	return Response.json({ ok: true });
}

/** The agent was revoked or its installation removed: stop its runs, tell it why, close the socket and drop what it left queued. */
async function onRevoke(dob: AgentDO, req: Request): Promise<Response> {
	const { reason } = await req.json<{ reason: "revoked" | "uninstalled" }>();
	if (reason !== "revoked" && reason !== "uninstalled") return Response.json({ error: "bad_request" }, { status: 400 });
	await interruptAccepted(dob, reason);
	dob.disconnect(CLOSE.revoked, "revoked", { v: 1, type: "error", code: "revoked", message: S.agentRevoked });
	// The agent never connects again, so its outbox, triggers and stored tails are dead weight.
	dob.sql.exec("DELETE FROM outbox");
	dob.sql.exec("DELETE FROM triggers");
	await pruneStoredTails(dob.state.storage, Number.POSITIVE_INFINITY);
	return Response.json({ ok: true });
}

/** Drops triggers finished more than TRIGGER_RETENTION_MS ago and the tails of runs that never ended. */
export async function pruneFinished(dob: AgentDO, now: number): Promise<boolean> {
	const before = now - TRIGGER_RETENTION_MS;
	dob.sql.exec("DELETE FROM triggers WHERE state IN ('done', 'superseded', 'rejected') AND created_at < ?", before);
	await pruneStoredTails(dob.state.storage, before);
	return false;
}

async function onInterrupt(dob: AgentDO, req: Request): Promise<Response> {
	const body = await req.json<Pick<Interrupt, "run_id" | "trigger_id" | "reason">>();
	if (body.run_id === undefined && body.trigger_id === undefined) return Response.json({ error: "bad_request" }, { status: 400 });
	const seq = await dob.send({ v: 1, type: "interrupt", run_id: body.run_id, trigger_id: body.trigger_id, reason: body.reason });
	return Response.json({ seq }, { status: 202 });
}

/**
 * A user's cancel of a run, by run id or trigger id. A gated run, or one the
 * offline agent never got, is cancelled here at once; anything the agent holds
 * is interrupted and the agent's own cancelled event ends the run.
 */
async function onCancel(dob: AgentDO, req: Request): Promise<Response> {
	const { run_id: runId } = await req.json<{ run_id?: string }>();
	if (typeof runId !== "string" || runId === "") return Response.json({ error: "bad_request" }, { status: 400 });
	const row = dob.sql.exec<TriggerRow>("SELECT * FROM triggers WHERE run_id = ?1 OR trigger_id = ?1", runId).toArray()[0];
	if (!row) return Response.json({ error: "unknown_run" }, { status: 404 });
	if (row.state !== "gated" && row.state !== "sent" && row.state !== "accepted") return Response.json({ error: "not_open" }, { status: 409 });
	const unseen = row.state === "gated" || (row.state === "sent" && !dob.isOnline());
	if (row.state !== "gated") {
		const target = row.run_id === null ? { trigger_id: row.trigger_id } : { run_id: row.run_id };
		await dob.send({ v: 1, type: "interrupt", ...target, reason: "cancelled" });
	}
	if (!unseen) return Response.json({ cancelled: false }, { status: 202 });
	dob.sql.exec("UPDATE triggers SET state = 'done' WHERE trigger_id = ?", row.trigger_id);
	const id = row.run_id ?? row.trigger_id;
	await updateRunState(dob.tenant(), id, "cancelled", { reason: "cancelled", finished_at: dob.clock.now() });
	await fanOutRun(dob, id, runUpdate);
	return Response.json({ cancelled: true }, { status: 202 });
}

/**
 * Runs when the agent goes offline: triggers it never accepted for
 * OFFLINE_PENDING_MS leave their runs pending with agent_offline. Keeps the
 * alarm while younger sent triggers wait.
 */
async function pendOfflineRuns(dob: AgentDO, now: number): Promise<boolean> {
	if (dob.isOnline()) return false;
	const sent = dob.sql.exec<TriggerRow>("SELECT * FROM triggers WHERE state = 'sent' ORDER BY created_at").toArray();
	const stale = sent.filter((row) => now - row.created_at >= OFFLINE_PENDING_MS);
	const t = dob.tenant();
	for (const row of stale) {
		const runId = row.run_id ?? row.trigger_id;
		if (await markRunPending(t, runId, "agent_offline")) await fanOutRun(dob, runId, runUpdate);
	}
	return sent.length > stale.length;
}

async function notifyAgentOffline(dob: AgentDO): Promise<void> {
	const sinks = await sinksFor(dob.bindings, dob.installationId, sinkHost(dob));
	if (sinks.length === 0) return;
	const agent = await getAgent(dob.tenant(), dob.agentId);
	if (!agent) return;
	const open = dob.sql.exec<TriggerRow>("SELECT * FROM triggers WHERE state IN ('sent', 'accepted') ORDER BY created_at").toArray();
	const affected = (
		await Promise.all(open.map((row) => loadRunView(dob.bindings, dob.installationId, { runId: row.run_id ?? row.trigger_id })))
	).filter((run): run is RunView => run !== null);
	const view = {
		agentId: agent.agent_id,
		installationId: agent.installation_id,
		name: agent.name,
		lastSeenAt: dob.status().last_seen_at ?? agent.last_seen_at ?? dob.clock.now(),
	};
	fanOut(dob.state, sinks, (sink) => sink.onAgentOffline(view, affected));
}

/** Installs the trigger, interrupt, repair and revoke routes, the run frame handlers, the offline alarm task and hook; returns a function that removes them. */
export function registerRunLifecycle(): () => void {
	const undo = [
		registerDoRoute("trigger", onTrigger),
		registerDoRoute("gate", onGate),
		registerDoRoute("interrupt", onInterrupt),
		registerDoRoute("cancel", onCancel),
		registerDoRoute("repair", onRepair),
		registerDoRoute("revoke", onRevoke),
		registerDoRoute("slack-fold", onSlackFold),

		registerFrameHandler("accepted", async (dob, frame) => {
			const row = triggerById(dob, frame.trigger_id);
			// First: a malformed or taken run_id throws a 4xx before anything records it.
			await acceptRun(dob.tenant(), row.trigger_id, frame.run_id, dob.agentId);
			await recordDeployReply(dob.bindings, dob.installationId, frame);
			dob.sql.exec(
				"UPDATE triggers SET run_id = ?, state = CASE WHEN state = 'sent' THEN 'accepted' ELSE state END WHERE trigger_id = ?",
				frame.run_id,
				row.trigger_id,
			);
			// Replaced after the agent already had it: stop the run it just started.
			if (row.state === "superseded") await dob.send({ v: 1, type: "interrupt", run_id: frame.run_id, reason: "superseded" });
			await fanOutRun(dob, frame.run_id, runUpdate);
		}),

		registerFrameHandler("rejected", async (dob, frame) => {
			const row = triggerById(dob, frame.trigger_id);
			await recordDeployReply(dob.bindings, dob.installationId, frame);
			// rejected too: a replay of a frame whose D1 write failed must write it again.
			if (row.state !== "sent" && row.state !== "accepted" && row.state !== "rejected") return;
			dob.sql.exec("UPDATE triggers SET state = 'rejected' WHERE trigger_id = ?", row.trigger_id);
			const runId = row.run_id ?? row.trigger_id;
			await updateRunState(dob.tenant(), runId, "skipped", { reason: frame.reason, finished_at: dob.clock.now() });
			await fanOutRun(dob, runId, runUpdate);
		}),

		registerFrameHandler("job_planned", async (dob, frame) => {
			ownedRun(dob, frame.run_id);
			const t = dob.tenant();
			const names = new Set(await listJobNames(t, frame.run_id));
			for (const job of frame.jobs) names.add(job.name);
			if (names.size > QUOTAS.jobsPerRun) {
				throw new HubError("job_limit", 422, `run ${frame.run_id} would have ${names.size} jobs, over the ${QUOTAS.jobsPerRun} limit`);
			}
			for (const job of frame.jobs) {
				await upsertJob(t, { run_id: frame.run_id, name: job.name, state: "queued", step: null, step_index: null, steps_total: null, duration_ms: null });
			}
			if (frame.slack) await setRunSlackOverride(t, frame.run_id, frame.slack);
			await fanOutRun(dob, frame.run_id, (sink, run) => sink.onJobPlanned(run));
		}),

		registerFrameHandler("event", async (dob, frame) => {
			const row = ownedRun(dob, frame.run_id);
			const t = dob.tenant();
			const { job: name } = frame;
			if (name !== undefined) {
				const names = await listJobNames(t, frame.run_id);
				if (!names.includes(name) && names.length >= QUOTAS.jobsPerRun) {
					logEvent("job_limit", { installation_id: dob.installationId, agent_id: dob.agentId, run_id: frame.run_id, job: name });
					return;
				}
				await upsertJob(t, {
					run_id: frame.run_id,
					name,
					state: frame.state,
					step: frame.step ?? null,
					step_index: frame.step_index ?? null,
					steps_total: frame.steps_total ?? null,
					duration_ms: frame.duration_ms ?? null,
				});
				if (frame.logs === "local") await markJobLogsLocal(t, frame.run_id, name);
				await fanOutRun(dob, frame.run_id, async (sink, run) => {
					const job = run.jobs.find((j) => j.name === name);
					if (job) await sink.onJobUpdate(run, { ...job, reason: frame.reason, tail: frame.tail, logs: frame.logs });
				});
				await onDeployEvent(dob.bindings, dob.installationId, frame, dob.state, sinkHost(dob));
				return;
			}
			const now = dob.clock.now();
			// A running event that names a step is setup progress, not the run starting: it must not restart the clock.
			if (frame.state === "running" && frame.step !== undefined) {
				await updateRunState(t, frame.run_id, "running", {
					setup_step: frame.step,
					setup_step_index: frame.step_index ?? null,
					setup_steps_total: frame.steps_total ?? null,
				});
				return;
			}
			const clearSetup = { setup_step: null, setup_step_index: null, setup_steps_total: null };
			const patch: RunPatch =
				frame.state === "running"
					? { started_at: now, reason: null, ...clearSetup }
					: TERMINAL[frame.state]
						? { finished_at: now, duration_ms: frame.duration_ms, reason: frame.reason, ...clearSetup }
						: { reason: frame.reason };
			if (TERMINAL[frame.state]) {
				dob.sql.exec("UPDATE triggers SET state = 'done' WHERE trigger_id = ?", row.trigger_id);
				// A push's deploys are recorded before its checks run reads as done, so no sink sees the run passed without them.
				// The view is read before this frame's state is written: a run D1 already ended (superseded, cancelled) chains nothing.
				const view = await loadRunView(dob.bindings, dob.installationId, { runId: frame.run_id });
				if (view && !RUN_ENDED.has(view.state) && view.target === "checks" && view.reason !== "suspended") {
					const check = aggregateFor({ ...view, state: frame.state }, dob.bindings.HUB_ORIGIN);
					if (check.status === "completed") await chainDeploys(dob.bindings, view, check.conclusion);
				}
			}
			await updateRunState(t, frame.run_id, frame.state, patch);
			await fanOutRun(dob, frame.run_id, runUpdate);
			await onDeployEvent(dob.bindings, dob.installationId, frame, dob.state, sinkHost(dob));
		}),

		registerFrameHandler("annotations", async (dob, frame) => {
			ownedRun(dob, frame.run_id);
			const valid = validAnnotations(frame.items);
			// Stored before the sinks hear of them: a failing insert replays the frame, a failing sink does not.
			if (typeof frame.job === "string") await insertAnnotations(dob.tenant(), frame.run_id, frame.job, valid, dob.clock.now());
			const annotations: Annotation[] = valid.map((item) => ({
				path: item.path,
				start_line: item.line,
				end_line: item.line,
				level: item.level,
				message: item.message,
				title: item.title,
			}));
			await fanOutRun(dob, frame.run_id, (sink, run) => sink.onAnnotations(run, frame.job, annotations));
		}),

		registerFrameHandler("token_request", async (dob, frame) => {
			const row = triggerByRun(dob, frame.run_id) ?? sentDeployTrigger(dob, frame.run_id);
			const binding = row && (await getBinding(dob.tenant(), row.repo_id, row.target));
			if (!row || binding?.agent_id !== dob.agentId) {
				logEvent("tenant_denied", { installation_id: dob.installationId, agent_id: dob.agentId, run_id: frame.run_id, reason: "run_not_bound" });
				await dob.send({ v: 1, type: "error", code: "auth_failed", run_id: frame.run_id, message: S.runNotBound });
				return;
			}
			const github = new GitHubClient(dob.bindings, dob.bindings.__TEST_FETCHER ?? defaultFetcher, () => dob.clock.now());
			const { token, exp } = await github.mintFetchToken(dob.installationId, row.repo_id);
			await dob.send({ v: 1, type: "token", run_id: frame.run_id, token, exp });
		}),

		registerAlarmTask(pendOfflineRuns),
		registerAlarmTask(pruneFinished),
		registerOfflineHook(notifyAgentOffline),
	];
	return () => {
		for (const fn of undo) fn();
	};
}
