// GET /v1/agent/connect: authenticates an agent's WebSocket upgrade and hands
// it to the agent's AgentDO.

import type { Context } from "hono";
import { getInstallation } from "../db/installations";
import { hitIpRate } from "../db/ip-rate";
import type { Env } from "../env";
import { HubError } from "../errors";
import { QUOTAS } from "../quotas";
import { authenticateAgent } from "./agent-auth";

export async function agentConnect(c: Context<{ Bindings: Env }>): Promise<Response> {
	if (c.req.header("upgrade")?.toLowerCase() !== "websocket") throw new HubError("upgrade_required", 426);

	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	const rate = await hitIpRate(c.env.DB, `agentconn:${ip}`, QUOTAS.agentConnectsPerMinPerIp, 60_000, Date.now());
	if (!rate.ok) {
		return c.json({ error: "rate_limited" }, 429, { "Retry-After": String(rate.retryAfterSeconds) });
	}

	const agent = await authenticateAgent(c.env, c.req.header("authorization"));
	const installation = await getInstallation(c.env.DB, agent.installation_id);
	if (!installation || installation.suspended_at !== null || installation.deleted_at !== null) {
		throw new HubError("suspended", 403);
	}

	const stub = c.env.AGENT_DO.get(c.env.AGENT_DO.idFromName(agent.agent_id));
	return stub.fetch("https://do/connect", {
		headers: {
			upgrade: "websocket",
			"x-zeroci-agent-id": agent.agent_id,
			"x-zeroci-installation-id": String(agent.installation_id),
		},
	});
}
