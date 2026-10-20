// The App Home tab: per linked installation its agents, watched repos and
// last runs, with admin-only Add agent and Revoke buttons.

import { type AgentRow, listAgents } from "../db/agents";
import { getInstallation } from "../db/installations";
import { listRepos } from "../db/repos";
import { listRecentRuns } from "../db/runs";
import { tenantDb } from "../db/tenant";
import { listLinkedInstallationIds } from "../db/workspaces";
import type { AgentStatus } from "../do/agent";
import { PROTOCOL_MAX } from "../do/agent-protocol";
import type { Env } from "../env";
import { getLinkedUser, type LinkedUser } from "../identity/link";
import { reportError } from "../observability";
import { loadRunView } from "../sinks/runview";
import type { AgentView, RunView } from "../sinks/types";
import { S } from "../strings";
import { slackApi } from "./api";
import { renderBadge } from "./badge";
import { type ButtonElement, actions, button, context, header, section } from "./blocks";
import { commandGitHub, isInstallationAdmin } from "./resolve";
import { type SlackView, confirmRevoke } from "./views";

/** Slack rejects views with more blocks than this. */
export const MAX_HOME_BLOCKS = 100;
export const RECENT_RUNS = 10;
const STATUS_TIMEOUT_MS = 1000;

export type HomeAgent = AgentView & {
	status: "online" | "offline" | "revoked";
	hostname: string;
	agentVersion: string | null;
	/** Never connected when null. */
	lastSeen: number | null;
	upgradeHint?: string;
};

export interface HomeInstallation {
	id: number;
	accountLogin: string;
	isAdmin: boolean;
	agents: HomeAgent[];
	repos: { fullName: string; channels: string[] }[];
	recentRuns: RunView[];
}

export interface HomeData {
	linked: boolean;
	installations: HomeInstallation[];
}

/**
 * The hint to upgrade an agent on an older protocol, or older than the hub's
 * recommended agent version (empty when unknown); undefined when current or
 * the agent's version is unknown.
 */
export function upgradeHint(protocol: number | null, agentVersion: string | null, latestAgentVersion: string): string | undefined {
	if (protocol !== null && protocol < PROTOCOL_MAX) return S.home.upgradeAvailable(latestAgentVersion);
	const agent = parseVersion(agentVersion);
	const latest = parseVersion(latestAgentVersion);
	if (!agent || !latest) return undefined;
	return isOlder(agent, latest) ? S.home.upgradeAvailable(latestAgentVersion) : undefined;
}

type Version = { core: [number, number, number]; prerelease: boolean };

function parseVersion(version: string | null): Version | null {
	const m = version?.match(/^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/);
	return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] !== undefined } : null;
}

/** a < b by major, minor, patch; a prerelease sorts below its release. */
function isOlder(a: Version, b: Version): boolean {
	for (let i = 0; i < 3; i++) {
		if (a.core[i] !== b.core[i]) return (a.core[i] ?? 0) < (b.core[i] ?? 0);
	}
	return a.prerelease && !b.prerelease;
}

/** The AgentDO's live status, or null when it fails or takes longer than a second. */
async function liveStatus(env: Env, agentId: string): Promise<AgentStatus | null> {
	const signal = AbortSignal.timeout(STATUS_TIMEOUT_MS);
	const timedOut = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
	const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(agentId));
	const res = await Promise.race([stub.fetch("https://do/status", { signal }), timedOut]);
	if (!res.ok) return null;
	return res.json<AgentStatus>();
}

async function homeAgents(env: Env, rows: AgentRow[]): Promise<HomeAgent[]> {
	const live = await Promise.allSettled(rows.map((row) => (row.status === "revoked" || row.revoked_at !== null ? Promise.resolve(null) : liveStatus(env, row.agent_id))));
	return rows.map((row, i) => {
		const result = live[i];
		const status = result?.status === "fulfilled" ? result.value : null;
		const revoked = row.status === "revoked" || row.revoked_at !== null;
		const lastSeen = status?.last_seen_at ?? row.last_seen_at;
		const agentVersion = status?.agent_version ?? row.agent_version;
		const hint = revoked ? undefined : upgradeHint(status?.protocol ?? row.protocol_version, agentVersion, env.LATEST_AGENT_VERSION);
		return {
			agentId: row.agent_id,
			installationId: row.installation_id,
			name: row.name,
			lastSeenAt: lastSeen ?? row.paired_at,
			lastSeen,
			hostname: row.hostname ?? row.name,
			agentVersion,
			status: revoked ? "revoked" : status ? (status.online ? "online" : "offline") : row.status === "online" ? "online" : "offline",
			...(hint ? { upgradeHint: hint } : {}),
		};
	});
}

async function loadInstallation(env: Env, teamId: string, installationId: number, user: LinkedUser | null): Promise<HomeInstallation | null> {
	const installation = await getInstallation(env.DB, installationId);
	if (!installation) return null;
	const t = tenantDb(env.DB, installationId);
	const [isAdmin, agentRows, repoRows, watches, runRows] = await Promise.all([
		user ? isInstallationAdmin(env, commandGitHub(env), installation, user) : Promise.resolve(false),
		listAgents(t),
		listRepos(t),
		t.all<{ repo_id: number; channel_id: string }>(
			"SELECT repo_id, channel_id FROM watches WHERE installation_id = ?1 AND team_id = ?2 AND status = 'active' ORDER BY channel_id",
			teamId,
		),
		listRecentRuns(t, RECENT_RUNS),
	]);
	const channels = new Map<number, string[]>();
	for (const w of watches) channels.set(w.repo_id, [...(channels.get(w.repo_id) ?? []), w.channel_id]);
	const runs = await Promise.all(runRows.map((run) => loadRunView(env, installationId, { runId: run.run_id })));
	return {
		id: installationId,
		accountLogin: installation.account_login,
		isAdmin,
		agents: await homeAgents(env, agentRows),
		repos: repoRows.flatMap((repo) => {
			const list = channels.get(repo.repo_id);
			return list ? [{ fullName: repo.full_name, channels: list }] : [];
		}),
		recentRuns: runs.filter((run): run is RunView => run !== null),
	};
}

export async function loadHomeData(env: Env, teamId: string, slackUserId: string): Promise<HomeData> {
	const user = await getLinkedUser(env, teamId, slackUserId);
	const ids = await listLinkedInstallationIds(env.DB, teamId);
	const installations = await Promise.all(ids.map((id) => loadInstallation(env, teamId, id, user)));
	return { linked: user !== null, installations: installations.filter((i): i is HomeInstallation => i !== null) };
}

function escapeMrkdwn(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function agentLine(agent: HomeAgent): string {
	const state =
		agent.status === "online"
			? S.home.agentOnline
			: agent.status === "revoked"
				? S.home.agentRevoked
				: agent.lastSeen === null
					? S.home.agentNeverSeen
					: S.home.agentOffline(`<!date^${Math.floor(agent.lastSeen / 1000)}^{ago}|${new Date(agent.lastSeen).toISOString()}>`);
	const parts = [state, `*${escapeMrkdwn(agent.hostname)}*`];
	if (agent.agentVersion) parts.push(escapeMrkdwn(agent.agentVersion));
	if (agent.upgradeHint) parts.push(agent.upgradeHint);
	return parts.join(" | ");
}

/** One installation's blocks, with at most runs run lines and repos repo lines. */
function installationBlocks(inst: HomeInstallation, runs: number, repos: number): unknown[] {
	const blocks: unknown[] = [header(inst.accountLogin), section(S.home.agents)];
	if (inst.agents.length === 0) blocks.push(context(S.home.noAgents));
	for (const agent of inst.agents) blocks.push(context(agentLine(agent)));
	if (inst.isAdmin) {
		const buttons: ButtonElement[] = [button("home:add_agent", S.home.addAgent, String(inst.id), "primary")];
		for (const agent of inst.agents) {
			if (agent.status === "revoked") continue;
			buttons.push({ ...button(`home:revoke_agent:${agent.agentId}`, S.home.revoke(agent.hostname), String(inst.id), "danger"), confirm: confirmRevoke(agent.hostname) });
		}
		blocks.push(actions(...buttons));
	}
	blocks.push(section(S.home.repos));
	if (inst.repos.length === 0) blocks.push(context(S.home.noRepos));
	for (const repo of inst.repos.slice(0, repos)) {
		blocks.push(section(`${escapeMrkdwn(repo.fullName)} -> ${repo.channels.map((c) => `<#${c}>`).join(", ")}`));
	}
	blocks.push(section(S.home.runs));
	if (inst.recentRuns.length === 0) blocks.push(context(S.home.noRuns));
	for (const run of inst.recentRuns.slice(0, runs)) blocks.push(section(renderBadge(run).text));
	return blocks;
}

/**
 * The Home tab view, led by notice when an action has something to tell the
 * user. Over 100 blocks it drops runs first, then repos, and ends with a
 * truncation note.
 */
export function renderHome(data: HomeData, notice?: string): SlackView {
	const lead: unknown[] = [];
	if (notice !== undefined) lead.push(section(notice));
	if (!data.linked) lead.push(section(S.home.linkPrompt));
	if (data.installations.length === 0) lead.push(section(S.home.noInstallations));
	const footer = actions(button("home:refresh", S.home.refresh, "refresh"));

	const runs = data.installations.map((i) => Math.min(i.recentRuns.length, RECENT_RUNS));
	const repos = data.installations.map((i) => i.repos.length);
	const build = () => [...lead, ...data.installations.flatMap((inst, i) => installationBlocks(inst, runs[i] ?? 0, repos[i] ?? 0)), footer];
	let blocks = build();
	if (blocks.length <= MAX_HOME_BLOCKS) return { type: "home", blocks };

	// Leave room for the truncation note, then trim from the last installation backwards.
	let excess = blocks.length - (MAX_HOME_BLOCKS - 1);
	for (const counts of [runs, repos]) {
		for (let i = counts.length - 1; i >= 0 && excess > 0; i--) {
			const cut = Math.min(counts[i] ?? 0, excess);
			counts[i] = (counts[i] ?? 0) - cut;
			excess -= cut;
		}
	}
	blocks = build();
	if (blocks.length > MAX_HOME_BLOCKS - 1) blocks = [...blocks.slice(0, MAX_HOME_BLOCKS - 2), footer];
	return { type: "home", blocks: [...blocks, context(S.home.truncated)] };
}

/**
 * Publishes the Home tab for slackUserId, led by notice when given: Home tab
 * actions have no response_url, so this is how their replies reach the user.
 */
export async function publishHome(env: Env, teamId: string, slackUserId: string, notice?: string): Promise<void> {
	const view = renderHome(await loadHomeData(env, teamId, slackUserId), notice);
	try {
		await slackApi(env, teamId, "views.publish", { user_id: slackUserId, view });
	} catch (err) {
		reportError(err, { teamId, slack: "views.publish" });
		throw err;
	}
}
