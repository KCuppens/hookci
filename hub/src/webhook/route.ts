// Sends a trigger to the agent bound to its repo and target, through that
// agent's AgentDO, or records why it could not.

import { getBinding } from "../db/bindings";
import { getInstallation } from "../db/installations";
import { tenantDb } from "../db/tenant";
import type { Env } from "../env";
import { HubError } from "../errors";
import { gateForkRun } from "../forks/gate";
import { isForkPr } from "../forks/policy";
import type { HubTrigger } from "../github/normalize";
import { fetchRepoTriggers, triggerConfigRef, triggerWanted } from "../policy/repo-config";
import type { WaitUntil } from "../sinks";
import { notifyOutcome } from "./outcome";

export type RouteOutcome =
	| { kind: "dispatched"; agentId: string }
	| { kind: "gated"; agentId: string; reason: "fork_gated" | "fork_never" }
	| { kind: "not_wanted" }
	| { kind: "no_agent" }
	| { kind: "suspended" }
	| { kind: "deleted" }
	| { kind: "unknown_installation" };

/** Trust the agent runs a trigger with: fork pull requests are untrusted. */
export type Trust = "trusted" | "untrusted";

/**
 * Body of the AgentDO `POST https://do/trigger`; the DO defaults attempt to 1.
 * runId releases that gated fork run instead of creating a new one;
 * approvedBy is the GitHub login that approved it. triggerId is the id the
 * deploy chain already recorded in deploy_triggers; retry sends the agent a
 * `retry` event instead of the trigger's GitHub event.
 */
export type TriggerRequest = HubTrigger & {
	attempt?: number;
	trust: Trust;
	runId?: string;
	approvedBy?: string;
	triggerId?: string;
	retry?: boolean;
};

export async function routeTrigger(env: Env, trig: HubTrigger, ctx: WaitUntil): Promise<RouteOutcome> {
	const installation = await getInstallation(env.DB, trig.installationId);
	if (!installation) return { kind: "unknown_installation" };
	if (installation.deleted_at !== null) return { kind: "deleted" };
	if (installation.suspended_at !== null) {
		const outcome = { kind: "suspended" } as const;
		await notifyOutcome(env, trig, outcome, ctx);
		return outcome;
	}
	// Like an Actions workflow's `on:`, the repo's own config picks the branches; no check, no message otherwise.
	const cfg = await fetchRepoTriggers(env, trig.installationId, trig.repo, triggerConfigRef(trig));
	if (!triggerWanted(cfg, trig)) return { kind: "not_wanted" };

	const binding = await getBinding(tenantDb(env.DB, trig.installationId), trig.repoId, trig.target);
	if (!binding) {
		const outcome = { kind: "no_agent" } as const;
		await notifyOutcome(env, trig, outcome, ctx);
		return outcome;
	}

	const gate = await gateForkRun(env, trig, binding.agent_id);
	if (gate.gated) return { kind: "gated", agentId: binding.agent_id, reason: gate.reason };
	const body: TriggerRequest = { ...trig, trust: isForkPr(trig.pr) ? "untrusted" : "trusted" };
	const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(binding.agent_id));
	const res = await stub.fetch("https://do/trigger", {
		method: "POST",
		headers: { "x-hookci-agent-id": binding.agent_id },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new HubError("agent_do_failed", 502, `AgentDO /trigger answered ${res.status}`);
	return { kind: "dispatched", agentId: binding.agent_id };
}
