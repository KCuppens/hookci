// Reads behind the dashboard's Agents, Repositories and Settings tabs. Every
// statement is scoped to the installation by TenantDb, and none selects a
// credential: no credential_hash, no bot_token_ct.

import { TERMINAL } from "../slack/badge";
import type { BindingTarget } from "./bindings";
import type { TenantDb } from "./tenant";

export interface AgentListRow {
	agent_id: string;
	name: string;
	hostname: string | null;
	os: string | null;
	arch: string | null;
	/** The operating system the agent reported in hello, like "Ubuntu 22.04"; null until it does. */
	os_release: string | null;
	protocol_version: number | null;
	agent_version: string | null;
	last_seen_at: number | null;
	revoked_at: number | null;
	paired_at: number;
	status: "online" | "offline" | "revoked";
	runs_total: number;
	runs_open: number;
	/** Repositories with at least one binding to this agent. */
	repos: number;
}

const OPEN = `r.state NOT IN (${[...TERMINAL].map((s) => `'${s}'`).join(", ")})`;

/** The installation's agents, revoked ones included, with how many runs each has handled and how many are still open. */
export async function listAgentsWithRuns(t: TenantDb): Promise<AgentListRow[]> {
	return t.all<AgentListRow>(
		`SELECT a.agent_id, a.name, a.hostname, a.os, a.arch, a.os_release, a.protocol_version, a.agent_version, a.last_seen_at, a.revoked_at, a.paired_at, a.status,
			COUNT(r.run_id) AS runs_total,
			COALESCE(SUM(CASE WHEN ${OPEN} THEN 1 ELSE 0 END), 0) AS runs_open,
			(SELECT COUNT(DISTINCT b.repo_id) FROM repo_bindings b WHERE b.installation_id = a.installation_id AND b.agent_id = a.agent_id) AS repos
		FROM agents a
		LEFT JOIN runs r ON r.installation_id = a.installation_id AND r.agent_id = a.agent_id
		WHERE a.installation_id = ?1
		GROUP BY a.agent_id
		ORDER BY a.paired_at, a.agent_id`,
	);
}

export interface RepositoryListRow {
	repo_id: number;
	/** Null for a repository that only its runs still remember. */
	full_name: string | null;
	default_branch: string | null;
	run_count: number;
	last_run_id: string | null;
	last_state: string | null;
	last_started_at: number | null;
}

/** Repositories shown on the Repositories tab; one more is read to tell whether the list was cut. */
export const REPOSITORY_LIMIT = 500;

/** The installation's repositories plus any a run still names, each with its run count and newest run. */
export async function listRepositories(t: TenantDb): Promise<RepositoryListRow[]> {
	return t.all<RepositoryListRow>(
		`WITH stats AS (
			SELECT repo_id, COUNT(*) AS run_count, MAX(rowid) AS last_rowid FROM runs WHERE installation_id = ?1 GROUP BY repo_id
		), ids AS (
			SELECT repo_id FROM repos WHERE installation_id = ?1 UNION SELECT repo_id FROM stats
		)
		SELECT i.repo_id, p.full_name, p.default_branch, COALESCE(s.run_count, 0) AS run_count,
			l.run_id AS last_run_id, l.state AS last_state, l.started_at AS last_started_at
		FROM ids i
		LEFT JOIN repos p ON p.installation_id = ?1 AND p.repo_id = i.repo_id
		LEFT JOIN stats s ON s.repo_id = i.repo_id
		LEFT JOIN runs l ON l.rowid = s.last_rowid
		ORDER BY p.full_name IS NULL, p.full_name COLLATE NOCASE, i.repo_id
		LIMIT ?2`,
		REPOSITORY_LIMIT + 1,
	);
}

export interface RepositoryBindingRow {
	repo_id: number;
	/** `checks` or `deploy:<env>`. */
	target: BindingTarget;
	agent_id: string;
	agent_name: string;
	agent_status: "online" | "offline" | "revoked";
	agent_last_seen_at: number | null;
}

/** Every agent binding of the installation with the agent's name and liveness: which agent runs each repository's checks and deploys. */
export async function listRepositoryBindings(t: TenantDb): Promise<RepositoryBindingRow[]> {
	return t.all<RepositoryBindingRow>(
		`SELECT b.repo_id, b.target, b.agent_id, a.name AS agent_name, a.status AS agent_status, a.last_seen_at AS agent_last_seen_at
		FROM repo_bindings b JOIN agents a ON a.installation_id = b.installation_id AND a.agent_id = b.agent_id
		WHERE b.installation_id = ?1 ORDER BY b.repo_id, b.target`,
	);
}

export interface RepositoryWatchRow {
	repo_id: number;
	team_id: string;
	channel_id: string;
	channel_name: string | null;
	status: "active" | "broken";
	broken_reason: string | null;
}

/** Every Slack watch of the installation: the channels that hear about each repository. */
export async function listRepositoryWatches(t: TenantDb): Promise<RepositoryWatchRow[]> {
	return t.all<RepositoryWatchRow>(
		"SELECT repo_id, team_id, channel_id, channel_name, status, broken_reason FROM watches WHERE installation_id = ?1 ORDER BY repo_id, COALESCE(channel_name, channel_id), channel_id",
	);
}

export interface SlackLinkRow {
	team_id: string;
	team_name: string;
	status: "active" | "revoked" | "uninstalled";
	linked_at: number;
}

/** The Slack workspaces linked to the installation. The workspace's bot token is not read. */
export async function listSlackLinks(t: TenantDb): Promise<SlackLinkRow[]> {
	return t.all<SlackLinkRow>(
		`SELECT w.team_id, w.team_name, w.status, l.created_at AS linked_at
		FROM workspace_links l JOIN workspaces w ON w.team_id = l.team_id
		WHERE l.installation_id = ?1 ORDER BY w.team_name, w.team_id`,
	);
}

export interface InstallationUsage {
	runs_today: number;
	runs_total: number;
	agents_active: number;
	repos: number;
}

/** Counts for the Settings tab: today's runs as the daily quota counts them (UTC day), runs in all, agents not revoked, repositories. */
export async function getInstallationUsage(t: TenantDb, day: string): Promise<InstallationUsage> {
	const row = await t.first<InstallationUsage>(
		`SELECT
			(SELECT COALESCE(SUM(runs), 0) FROM daily_counters WHERE installation_id = ?1 AND day = ?2) AS runs_today,
			(SELECT COUNT(*) FROM runs WHERE installation_id = ?1) AS runs_total,
			(SELECT COUNT(*) FROM agents WHERE installation_id = ?1 AND revoked_at IS NULL) AS agents_active,
			(SELECT COUNT(*) FROM repos WHERE installation_id = ?1) AS repos`,
		day,
	);
	return row ?? { runs_today: 0, runs_total: 0, agents_active: 0, repos: 0 };
}
