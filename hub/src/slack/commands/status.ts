// /hookci status [owner/repo]: the agents of the installations linked to the
// workspace with their online state, and the repo's last 5 runs when named.

import { listAgents } from "../../db/agents";
import { listRecentRunsForRepo } from "../../db/runs";
import { tenantDb } from "../../db/tenant";
import { listLinkedInstallationIds } from "../../db/workspaces";
import type { Env } from "../../env";
import { requireLinkedUser } from "../../identity/link";
import { loadRunView } from "../../sinks/runview";
import { S } from "../../strings";
import { renderBadge } from "../badge";
import { section } from "../blocks";
import { liveStatus } from "../home";
import { registerCommand } from "../registry";
import { requireRepoAccess } from "../resolve";
import { commandArgs, ephemeral } from "./common";

const RECENT_RUNS = 5;

/** A Slack date token that renders in the reader's time zone. */
function slackDate(ms: number): string {
	return `<!date^${Math.floor(ms / 1000)}^{date_short_pretty} {time}|${new Date(ms).toISOString()}>`;
}

/** One line per active agent; an agent whose AgentDO fails or does not answer in time shows its D1 state. */
async function agentLines(env: Env, teamId: string): Promise<string[]> {
	const ids = await listLinkedInstallationIds(env.DB, teamId);
	const agents = (await Promise.all(ids.map((id) => listAgents(tenantDb(env.DB, id))))).flat().filter((agent) => agent.revoked_at === null);
	const live = await Promise.allSettled(agents.map((agent) => liveStatus(env, agent.agent_id)));
	const lines = agents.map((agent, i) => {
		const result = live[i];
		const status = result?.status === "fulfilled" ? result.value : null;
		const online = status ? status.online : agent.status === "online";
		const lastSeen = status?.last_seen_at ?? agent.last_seen_at;
		return `• ${
			online
				? S.slack.statusAgentOnline(agent.name, status?.agent_version ?? agent.agent_version)
				: S.slack.statusAgentOffline(agent.name, lastSeen === null ? S.slack.statusNeverSeen : slackDate(lastSeen))
		}`;
	});
	return lines.length > 0 ? lines : [S.slack.statusNoAgents];
}

registerCommand("status", async ({ env, teamId, userId, text }) => {
	const user = await requireLinkedUser(env, teamId, userId);
	const [fullName, ...rest] = commandArgs(text);
	if (rest.length > 0) return ephemeral(S.slack.usage("/hookci status [owner/repo]"));
	const repo = fullName ? (await requireRepoAccess(env, teamId, user, fullName, "read")).repo : null;
	const lines = [S.slack.statusAgents, ...(await agentLines(env, teamId))];
	if (repo) {
		lines.push(S.slack.statusRuns(repo.fullName));
		const runs = await listRecentRunsForRepo(tenantDb(env.DB, repo.installationId), repo.repoId, RECENT_RUNS);
		for (const run of runs) {
			const view = await loadRunView(env, repo.installationId, { runId: run.run_id });
			if (view) lines.push(renderBadge(view).text);
		}
		if (runs.length === 0) lines.push(S.slack.statusNoRuns(repo.fullName));
	}
	const body = lines.join("\n");
	return ephemeral(body, [section(body)]);
});
