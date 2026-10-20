// /zeroci status [owner/repo]: the agents of the installations linked to the
// workspace with their online state, and the repo's last 5 runs when named.

import { listAgents } from "../../db/agents";
import { listRecentRunsForRepo } from "../../db/runs";
import { tenantDb } from "../../db/tenant";
import { listLinkedInstallationIds } from "../../db/workspaces";
import type { Env } from "../../env";
import { HubError } from "../../errors";
import { requireLinkedUser } from "../../identity/link";
import { loadRunView } from "../../sinks/runview";
import { S } from "../../strings";
import { renderBadge } from "../badge";
import { section } from "../blocks";
import { registerCommand } from "../registry";
import { requireRepoAccess } from "../resolve";
import { commandArgs, ephemeral } from "./common";

const RECENT_RUNS = 5;

interface AgentStatus {
	online: boolean;
	agent_version: string | null;
}

/** The agent's live state from its AgentDO. */
async function agentStatus(env: Env, agentId: string): Promise<AgentStatus> {
	const res = await env.AGENT_DO.get(env.AGENT_DO.idFromName(agentId)).fetch("https://do/status");
	if (!res.ok) throw new HubError("agent_do_failed", 502, `status of ${agentId} answered ${res.status}`);
	return res.json<AgentStatus>();
}

/** A Slack date token that renders in the reader's time zone. */
function slackDate(ms: number): string {
	return `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} {time}|${new Date(ms).toISOString()}>`;
}

async function agentLines(env: Env, teamId: string): Promise<string[]> {
	const lines: string[] = [];
	for (const installationId of await listLinkedInstallationIds(env.DB, teamId)) {
		for (const agent of await listAgents(tenantDb(env.DB, installationId))) {
			if (agent.revoked_at !== null) continue;
			const status = await agentStatus(env, agent.agent_id);
			lines.push(
				`• ${
					status.online
						? S.slack.statusAgentOnline(agent.name, status.agent_version ?? agent.agent_version)
						: S.slack.statusAgentOffline(agent.name, agent.last_seen_at === null ? S.slack.statusNeverSeen : slackDate(agent.last_seen_at))
				}`,
			);
		}
	}
	return lines.length > 0 ? lines : [S.slack.statusNoAgents];
}

registerCommand("status", async ({ env, teamId, userId, text }) => {
	const user = await requireLinkedUser(env, teamId, userId);
	const [fullName, ...rest] = commandArgs(text);
	if (rest.length > 0) return ephemeral(S.slack.usage("/zeroci status [owner/repo]"));
	const repo = fullName ? (await requireRepoAccess(env, teamId, user, fullName, "read")).repo : null;
	const lines = [S.slack.statusAgents, ...(await agentLines(env, teamId))];
	if (repo) {
		lines.push(S.slack.statusRuns(repo.fullName));
		const runs = await listRecentRunsForRepo(tenantDb(env.DB, repo.installationId), repo.repoId, RECENT_RUNS);
		for (const run of runs) {
			const view = await loadRunView(env.DB, repo.installationId, { runId: run.run_id });
			if (view) lines.push(renderBadge(view).text);
		}
		if (runs.length === 0) lines.push(S.slack.statusNoRuns(repo.fullName));
	}
	const body = lines.join("\n");
	return ephemeral(body, [section(body)]);
});
