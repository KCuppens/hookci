// Sends a trigger to the agent bound to its repo and target, through that
// agent's AgentDO, or records why it could not.

import { getBinding } from "../db/bindings";
import { getInstallation } from "../db/installations";
import { insertRun } from "../db/runs";
import { tenantDb } from "../db/tenant";
import type { Env } from "../env";
import { HubError } from "../errors";
import type { HubTrigger } from "../github/normalize";
import { notifyOutcome } from "./outcome";

export type RouteOutcome =
	| { kind: "dispatched"; agentId: string }
	| { kind: "no_agent" }
	| { kind: "suspended" }
	| { kind: "unknown_installation" };

/** Trust the agent runs a trigger with: fork pull requests are untrusted. */
export type Trust = "trusted" | "untrusted";

/** Body of the AgentDO `POST https://do/trigger`. */
export type TriggerRequest = HubTrigger & { trust: Trust };

const DEPLOY_PREFIX = "deploy:";

export async function routeTrigger(env: Env, trig: HubTrigger): Promise<RouteOutcome> {
	const installation = await getInstallation(env.DB, trig.installationId);
	if (!installation) return { kind: "unknown_installation" };
	if (installation.suspended_at !== null || installation.deleted_at !== null) return { kind: "suspended" };

	const t = tenantDb(env.DB, trig.installationId);
	const binding = await getBinding(t, trig.repoId, trig.target);
	if (!binding) {
		await insertRun(t, {
			run_id: crypto.randomUUID(),
			repo_id: trig.repoId,
			sha: trig.sha,
			ref: trig.ref,
			event: trig.event,
			pr_number: trig.pr?.number ?? null,
			env: trig.target.startsWith(DEPLOY_PREFIX) ? trig.target.slice(DEPLOY_PREFIX.length) : null,
			attempt: 1,
			trigger_id: crypto.randomUUID(),
			agent_id: null,
			state: "pending",
			reason: "no_agent",
			author_login: trig.authorLogin,
			commit_title: trig.commitTitle,
			started_at: null,
			finished_at: null,
			duration_ms: null,
			log_key: null,
		});
		const outcome: RouteOutcome = { kind: "no_agent" };
		await notifyOutcome(env, trig, outcome);
		return outcome;
	}

	const body: TriggerRequest = { ...trig, trust: trig.pr?.fork ? "untrusted" : "trusted" };
	const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(binding.agent_id));
	const res = await stub.fetch("https://do/trigger", { method: "POST", body: JSON.stringify(body) });
	if (!res.ok) throw new HubError("agent_do_failed", 502, `AgentDO /trigger answered ${res.status}`);
	return { kind: "dispatched", agentId: binding.agent_id };
}
