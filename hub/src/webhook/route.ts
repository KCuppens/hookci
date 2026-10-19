// Sends a trigger to the agent bound to its repo and target, through that
// agent's AgentDO, or records why it could not.

import { getBinding } from "../db/bindings";
import { getInstallation } from "../db/installations";
import { tenantDb } from "../db/tenant";
import type { Env } from "../env";
import { HubError } from "../errors";
import type { HubTrigger } from "../github/normalize";
import type { WaitUntil } from "../sinks";
import { notifyOutcome } from "./outcome";

export type RouteOutcome =
	| { kind: "dispatched"; agentId: string }
	| { kind: "no_agent" }
	| { kind: "suspended" }
	| { kind: "unknown_installation" };

/** Trust the agent runs a trigger with: fork pull requests are untrusted. */
export type Trust = "trusted" | "untrusted";

/** Body of the AgentDO `POST https://do/trigger`; the DO defaults attempt to 1 and trust to trusted. */
export type TriggerRequest = HubTrigger & { attempt?: number; trust?: Trust };

export async function routeTrigger(env: Env, trig: HubTrigger, ctx: WaitUntil): Promise<RouteOutcome> {
	const installation = await getInstallation(env.DB, trig.installationId);
	if (!installation) return { kind: "unknown_installation" };
	if (installation.suspended_at !== null || installation.deleted_at !== null) return { kind: "suspended" };

	const binding = await getBinding(tenantDb(env.DB, trig.installationId), trig.repoId, trig.target);
	if (!binding) {
		const outcome = { kind: "no_agent" } as const;
		await notifyOutcome(env, trig, outcome, ctx);
		return outcome;
	}

	const body: TriggerRequest = { ...trig, trust: trig.pr?.fork ? "untrusted" : "trusted" };
	const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(binding.agent_id));
	const res = await stub.fetch("https://do/trigger", {
		method: "POST",
		headers: { "x-zeroci-agent-id": binding.agent_id },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new HubError("agent_do_failed", 502, `AgentDO /trigger answered ${res.status}`);
	return { kind: "dispatched", agentId: binding.agent_id };
}
