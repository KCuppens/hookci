// The run lifecycle on the AgentDO: triggers in from the Worker, deduped by
// idempotency key, capped per day, superseding older work on the same pull
// request or branch, then the agent's accepted/rejected/job/event frames into
// D1, fetch tokens out, and every change fanned out to the sinks.
//
// A run's D1 run_id is its trigger_id until the agent accepts it and names
// the run; the triggers table remembers which run_id each trigger became.

import { getAgent } from "../db/agents";
import { type BindingTarget, deployEnv, getBinding } from "../db/bindings";
import { acceptRun, insertRun, markRunPending, type RunPatch, updateRunState, upsertJob } from "../db/runs";
import { HubError } from "../errors";
import { GitHubClient } from "../github/client";
import { defaultFetcher } from "../http";
import type { Event as EventFrame, Interrupt } from "../protocol";
import { QUOTAS } from "../quotas";
import { fanOut, sinksFor } from "../sinks";
import { loadRunView } from "../sinks/runview";
import type { Annotation, RunView, Sink } from "../sinks/types";
import { S } from "../strings";
import { ulid } from "../ulid";
import type { TriggerRequest } from "../webhook/route";
import type { AgentDO, OutboundFrame } from "./agent";
import { registerFrameHandler } from "./agent-frames";
import { registerAlarmTask, registerOfflineHook } from "./agent-hooks";
import { ALARM_INTERVAL_MS } from "./agent-protocol";
import { registerDoRoute } from "./agent-routes";

/** A trigger still `sent` this long while the agent is offline leaves its run pending with agent_offline. */
export const OFFLINE_PENDING_MS = 10 * 60_000;

type TriggerState = "sent" | "accepted" | "rejected" | "superseded" | "done";

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
	if (!row) throw new HubError("unknown_trigger", 404, `no trigger ${triggerId} on this agent`);
	return row;
}

/** The trigger the agent accepted as runId; null when this agent never ran it. */
function triggerByRun(dob: AgentDO, runId: string): TriggerRow | null {
	return dob.sql.exec<TriggerRow>("SELECT * FROM triggers WHERE run_id = ?", runId).toArray()[0] ?? null;
}

function ownedRun(dob: AgentDO, runId: string): TriggerRow {
	const row = triggerByRun(dob, runId);
	if (!row) throw new HubError("unknown_run", 404, `no run ${runId} on this agent`);
	return row;
}

/** Loads the run and hands it to fn for every sink, unless no sink is configured. */
async function fanOutRun(dob: AgentDO, runId: string, fn: (sink: Sink, run: RunView) => Promise<void>): Promise<void> {
	const sinks = await sinksFor(dob.bindings, dob.installationId);
	if (sinks.length === 0) return;
	const run = await loadRunView(dob.bindings.DB, dob.installationId, { runId });
	if (run) fanOut(dob.state, sinks, (sink) => fn(sink, run));
}

const runUpdate = (sink: Sink, run: RunView) => sink.onRunUpdate(run);

/**
 * Marks the older triggers trig replaces superseded and returns them with
 * the interrupts to send. Checks work on the same pull request (or, for a
 * push, the same branch) is replaced whether sent or running. Deploys are
 * only replaced while the agent has not received them; a running deploy is
 * never interrupted.
 */
function supersede(dob: AgentDO, own: TriggerRow): { replaced: TriggerRow[]; interrupts: OutboundFrame[] } {
	const scope = own.pr_number === null ? "pr_number IS NULL AND ref = ?" : "pr_number = ?";
	const older = dob.sql
		.exec<TriggerRow>(
			`SELECT * FROM triggers WHERE trigger_id != ? AND repo_id = ? AND target = ? AND state IN ('sent', 'accepted')
			${own.target === "checks" ? `AND ${scope}` : ""} ORDER BY created_at`,
			...[own.trigger_id, own.repo_id, own.target, ...(own.target === "checks" ? [own.pr_number ?? own.ref] : [])],
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

async function onTrigger(dob: AgentDO, req: Request): Promise<Response> {
	const agentId = req.headers.get("x-zeroci-agent-id");
	const trig = await req.json<TriggerRequest>();
	if (!agentId) return Response.json({ error: "bad_request" }, { status: 400 });
	if (!dob.adopt(agentId, trig.installationId)) return Response.json({ error: "agent_mismatch" }, { status: 409 });

	const now = dob.clock.now();
	const attempt = trig.attempt ?? 1;
	const own = dob.sql
		.exec<TriggerRow>(
			`INSERT INTO triggers (trigger_id, idem_key, repo_id, pr_number, ref, target, sha, state, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?) ON CONFLICT (idem_key) DO NOTHING RETURNING *`,
			ulid(now),
			idemKey(trig),
			trig.repoId,
			trig.pr?.number ?? null,
			trig.ref,
			trig.target,
			trig.sha,
			now,
		)
		.toArray()[0];
	if (!own) return Response.json({ duplicate: true });
	const triggerId = own.trigger_id;

	const t = dob.tenant();
	let capped: boolean;
	try {
		const day = new Date(now).toISOString().slice(0, 10);
		const counter = await t.first<{ runs: number }>(
			`INSERT INTO daily_counters (installation_id, day, runs) VALUES (?1, ?2, 1)
			ON CONFLICT (installation_id, day) DO UPDATE SET runs = runs + 1 RETURNING runs`,
			day,
		);
		capped = (counter?.runs ?? 0) > QUOTAS.runsPerDay;
		await insertRun(t, {
			run_id: triggerId,
			repo_id: trig.repoId,
			sha: trig.sha,
			ref: trig.ref,
			event: trig.event,
			pr_number: trig.pr?.number ?? null,
			env: deployEnv(trig.target),
			attempt,
			trigger_id: triggerId,
			agent_id: dob.agentId,
			state: capped ? "pending" : "received",
			reason: capped ? "daily_cap" : null,
			author_login: trig.authorLogin,
			commit_title: trig.commitTitle,
			started_at: null,
			finished_at: null,
			duration_ms: null,
			log_key: null,
		});
	} catch (err) {
		// Free the idempotency key so a redelivery of the webhook can try again.
		dob.sql.exec("DELETE FROM triggers WHERE trigger_id = ?", triggerId);
		throw err;
	}

	if (capped) {
		dob.sql.exec("UPDATE triggers SET state = 'done' WHERE trigger_id = ?", triggerId);
		await fanOutRun(dob, triggerId, runUpdate);
		return Response.json({ trigger_id: triggerId }, { status: 202 });
	}

	// A newer trigger may have replaced this one while D1 was awaited.
	const stillSent = triggerById(dob, triggerId).state === "sent";
	const { replaced, interrupts } = stillSent ? supersede(dob, own) : { replaced: [], interrupts: [] };
	if (stillSent) {
		const seq = await dob.send({
			v: 1,
			type: "trigger",
			trigger_id: triggerId,
			repo: trig.repo,
			sha: trig.sha,
			ref: trig.ref,
			event: trig.event,
			pr: trig.pr && {
				number: trig.pr.number,
				head_ref: trig.pr.headRef,
				head_repo_full_name: trig.pr.headRepoFullName,
				fork: trig.pr.fork,
			},
			base_sha: trig.baseSha,
			attempt,
			trust: trig.trust ?? "trusted",
		});
		dob.sql.exec("UPDATE triggers SET outbox_seq = ? WHERE trigger_id = ?", seq, triggerId);
	}
	for (const interrupt of interrupts) await dob.send(interrupt);

	await updateRunState(t, triggerId, stillSent ? "queued" : "superseded", stillSent ? {} : { finished_at: now });
	for (const row of replaced) await updateRunState(t, row.run_id ?? row.trigger_id, "superseded", { finished_at: now });
	await Promise.all([triggerId, ...replaced.map((row) => row.run_id ?? row.trigger_id)].map((id) => fanOutRun(dob, id, runUpdate)));

	if (stillSent && !dob.isOnline() && (await dob.state.storage.getAlarm()) === null) {
		await dob.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
	}
	return Response.json({ trigger_id: triggerId }, { status: 202 });
}

async function onInterrupt(dob: AgentDO, req: Request): Promise<Response> {
	const body = await req.json<Pick<Interrupt, "run_id" | "trigger_id" | "reason">>();
	if (body.run_id === undefined && body.trigger_id === undefined) return Response.json({ error: "bad_request" }, { status: 400 });
	const seq = await dob.send({ v: 1, type: "interrupt", run_id: body.run_id, trigger_id: body.trigger_id, reason: body.reason });
	return Response.json({ seq }, { status: 202 });
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
	const sinks = await sinksFor(dob.bindings, dob.installationId);
	if (sinks.length === 0) return;
	const agent = await getAgent(dob.tenant(), dob.agentId);
	if (!agent) return;
	const open = dob.sql.exec<TriggerRow>("SELECT * FROM triggers WHERE state IN ('sent', 'accepted') ORDER BY created_at").toArray();
	const affected = (
		await Promise.all(open.map((row) => loadRunView(dob.bindings.DB, dob.installationId, { runId: row.run_id ?? row.trigger_id })))
	).filter((run): run is RunView => run !== null);
	const view = {
		agentId: agent.agent_id,
		installationId: agent.installation_id,
		name: agent.name,
		lastSeenAt: dob.status().last_seen_at ?? agent.last_seen_at ?? dob.clock.now(),
	};
	fanOut(dob.state, sinks, (sink) => sink.onAgentOffline(view, affected));
}

/** Installs the trigger and interrupt routes, the run frame handlers, the offline alarm task and hook; returns a function that removes them. */
export function registerRunLifecycle(): () => void {
	const undo = [
		registerDoRoute("trigger", onTrigger),
		registerDoRoute("interrupt", onInterrupt),

		registerFrameHandler("accepted", async (dob, frame) => {
			const row = triggerById(dob, frame.trigger_id);
			dob.sql.exec(
				"UPDATE triggers SET run_id = ?, state = CASE WHEN state = 'sent' THEN 'accepted' ELSE state END WHERE trigger_id = ?",
				frame.run_id,
				row.trigger_id,
			);
			// Replaced after the agent already had it: stop the run it just started.
			if (row.state === "superseded") await dob.send({ v: 1, type: "interrupt", run_id: frame.run_id, reason: "superseded" });
			await acceptRun(dob.tenant(), row.run_id ?? row.trigger_id, frame.run_id, dob.agentId);
			await fanOutRun(dob, frame.run_id, runUpdate);
		}),

		registerFrameHandler("rejected", async (dob, frame) => {
			const row = triggerById(dob, frame.trigger_id);
			if (row.state !== "sent" && row.state !== "accepted") return;
			dob.sql.exec("UPDATE triggers SET state = 'rejected' WHERE trigger_id = ?", row.trigger_id);
			const runId = row.run_id ?? row.trigger_id;
			await updateRunState(dob.tenant(), runId, "skipped", { reason: frame.reason, finished_at: dob.clock.now() });
			await fanOutRun(dob, runId, runUpdate);
		}),

		registerFrameHandler("job_planned", async (dob, frame) => {
			ownedRun(dob, frame.run_id);
			const t = dob.tenant();
			for (const job of frame.jobs) {
				await upsertJob(t, { run_id: frame.run_id, name: job.name, state: "queued", step: null, step_index: null, steps_total: null, duration_ms: null });
			}
			await fanOutRun(dob, frame.run_id, (sink, run) => sink.onJobPlanned(run));
		}),

		registerFrameHandler("event", async (dob, frame) => {
			const row = ownedRun(dob, frame.run_id);
			const t = dob.tenant();
			const { job: name } = frame;
			if (name !== undefined) {
				await upsertJob(t, {
					run_id: frame.run_id,
					name,
					state: frame.state,
					step: frame.step ?? null,
					step_index: frame.step_index ?? null,
					steps_total: frame.steps_total ?? null,
					duration_ms: frame.duration_ms ?? null,
				});
				await fanOutRun(dob, frame.run_id, async (sink, run) => {
					const job = run.jobs.find((j) => j.name === name);
					if (job) await sink.onJobUpdate(run, job);
				});
				return;
			}
			const now = dob.clock.now();
			const patch: RunPatch =
				frame.state === "running"
					? { started_at: now, reason: null }
					: TERMINAL[frame.state]
						? { finished_at: now, duration_ms: frame.duration_ms, reason: frame.reason }
						: { reason: frame.reason };
			if (TERMINAL[frame.state]) dob.sql.exec("UPDATE triggers SET state = 'done' WHERE trigger_id = ?", row.trigger_id);
			await updateRunState(t, frame.run_id, frame.state, patch);
			await fanOutRun(dob, frame.run_id, runUpdate);
		}),

		registerFrameHandler("annotations", async (dob, frame) => {
			ownedRun(dob, frame.run_id);
			const annotations: Annotation[] = frame.items.map((item) => ({
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
			const row = triggerByRun(dob, frame.run_id);
			const binding = row && (await getBinding(dob.tenant(), row.repo_id, row.target));
			if (!row || binding?.agent_id !== dob.agentId) {
				await dob.send({ v: 1, type: "error", code: "auth_failed", message: S.runNotBound });
				return;
			}
			const github = new GitHubClient(dob.bindings, dob.bindings.__TEST_FETCHER ?? defaultFetcher, () => dob.clock.now());
			const { token, exp } = await github.mintFetchToken(dob.installationId, row.repo_id);
			await dob.send({ v: 1, type: "token", run_id: frame.run_id, token, exp });
		}),

		registerAlarmTask(pendOfflineRuns),
		registerOfflineHook(notifyAgentOffline),
	];
	return () => {
		for (const fn of undo) fn();
	};
}
