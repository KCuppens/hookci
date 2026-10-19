import { deployEnv } from "../db/bindings";
import { insertRun } from "../db/runs";
import { tenantDb } from "../db/tenant";
import type { Env } from "../env";
import type { HubTrigger } from "../github/normalize";
import { logEvent } from "../observability";
import { fanOut, sinksFor, type WaitUntil } from "../sinks";
import { loadRunView } from "../sinks/runview";
import { ulid } from "../ulid";
import type { RouteOutcome } from "./route";

/**
 * Records a trigger that reached no agent as a pending run, with the outcome
 * as its reason, and tells the sinks about it.
 */
export async function notifyOutcome(
	env: Env,
	trig: HubTrigger,
	outcome: Extract<RouteOutcome, { kind: "no_agent" }>,
	ctx: WaitUntil,
): Promise<void> {
	logEvent("webhook_outcome", {
		installation_id: trig.installationId,
		repo_id: trig.repoId,
		repo: trig.repo,
		sha: trig.sha,
		target: trig.target,
		outcome: outcome.kind,
	});
	const triggerId = ulid();
	await insertRun(tenantDb(env.DB, trig.installationId), {
		run_id: triggerId,
		repo_id: trig.repoId,
		sha: trig.sha,
		ref: trig.ref,
		event: trig.event,
		pr_number: trig.pr?.number ?? null,
		env: deployEnv(trig.target),
		attempt: 1,
		trigger_id: triggerId,
		agent_id: null,
		state: "pending",
		reason: outcome.kind,
		author_login: trig.authorLogin,
		commit_title: trig.commitTitle,
		started_at: null,
		finished_at: null,
		duration_ms: null,
		log_key: null,
	});
	const [view, sinks] = await Promise.all([
		loadRunView(env.DB, trig.installationId, { runId: triggerId }),
		sinksFor(env, trig.installationId),
	]);
	if (view) fanOut(ctx, sinks, (sink) => sink.onRunUpdate(view));
}
