// GitHub `installation` and `installation_repositories` webhooks. created
// syncs the installation and its repos (shared with the install callback);
// new_permissions_accepted stores the new permissions; deleted marks the
// installation for purge in 24 h and stops its agents; suspend and unsuspend
// set and clear suspended_at. Added repos are bound to an agent, removed
// repos are forgotten and their watching channels told.

import { listAgents, pickAgentForNewRepos } from "../db/agents";
import { bindRepos } from "../db/bindings";
import { getInstallation, markDeleted, markSuspended, setInstallationPermissions, upsertInstallation } from "../db/installations";
import { listRepos, removeRepos, upsertRepos } from "../db/repos";
import { cancelOpenRuns } from "../db/runs";
import { tenantDb } from "../db/tenant";
import { listWatchesForRepos } from "../db/watches";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { listInstallationRepos } from "../github/api";
import { GitHubClient, invalidateInstallation } from "../github/client";
import { defaultFetcher } from "../http";
import { reportError } from "../observability";
import { revokeAgent } from "../pairing/agents";
import { slackApiFireAndForget } from "../slack/api";
import { S } from "../strings";
import { registerHandler } from "./handlers";

/** How long a deleted installation's data is kept before the purge cron removes it. */
const PURGE_GRACE_MS = 86_400_000;

export interface InstallationAccount {
	id: number;
	login: string;
	type: "User" | "Organization";
}

/** The installation fields the hub stores, as sent in webhooks and by GET /user/installations. */
export interface SyncableInstallation {
	id: number;
	account: InstallationAccount;
	permissions: Record<string, string>;
}

export interface InstallationPayload {
	action: string;
	installation: SyncableInstallation;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for an installation on a User or Organization account, with an account id and string permissions. */
export function isSyncableInstallation(value: unknown): value is SyncableInstallation {
	return (
		isObject(value) &&
		Number.isSafeInteger(value.id) &&
		isObject(value.account) &&
		Number.isSafeInteger(value.account.id) &&
		typeof value.account.login === "string" &&
		(value.account.type === "User" || value.account.type === "Organization") &&
		isObject(value.permissions) &&
		Object.values(value.permissions).every((p) => typeof p === "string")
	);
}

function isInstallationPayload(value: unknown): value is InstallationPayload {
	return isObject(value) && typeof value.action === "string" && isSyncableInstallation(value.installation);
}

export interface WebhookRepo {
	id: number;
	full_name: string;
}

export interface InstallationRepositoriesPayload {
	action: string;
	installation: { id: number };
	sender: { id: number };
	repositories_added: WebhookRepo[];
	repositories_removed: WebhookRepo[];
}

function isWebhookRepoList(value: unknown): value is WebhookRepo[] {
	return Array.isArray(value) && value.every((r) => isObject(r) && Number.isSafeInteger(r.id) && typeof r.full_name === "string");
}

function isInstallationRepositoriesPayload(value: unknown): value is InstallationRepositoriesPayload {
	return (
		isObject(value) &&
		typeof value.action === "string" &&
		isObject(value.installation) &&
		Number.isSafeInteger(value.installation.id) &&
		isObject(value.sender) &&
		Number.isSafeInteger(value.sender.id) &&
		isWebhookRepoList(value.repositories_added) &&
		isWebhookRepoList(value.repositories_removed)
	);
}

function githubClient(env: Env): GitHubClient {
	const clock = env.__TEST_CLOCK ?? systemClock;
	return new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, () => clock.now());
}

/**
 * Upserts the installation (a reinstall clears a pending purge), stores its
 * permissions, and replaces its repos with the list its installation token
 * sees. Idempotent.
 */
export async function syncInstallation(env: Env, github: GitHubClient, inst: SyncableInstallation, now: number): Promise<void> {
	await upsertInstallation(env.DB, {
		id: inst.id,
		account_login: inst.account.login,
		account_type: inst.account.type,
		account_id: inst.account.id,
		created_at: now,
	});
	await setInstallationPermissions(env.DB, inst.id, inst.permissions);
	const listed = await listInstallationRepos(await github.installation(inst.id));
	const t = tenantDb(env.DB, inst.id);
	await upsertRepos(
		t,
		listed.map((r) => ({ repo_id: r.id, full_name: r.full_name, default_branch: r.default_branch })),
	);
	const kept = new Set(listed.map((r) => r.id));
	await removeRepos(
		t,
		(await listRepos(t)).filter((r) => !kept.has(r.repo_id)).map((r) => r.repo_id),
	);
}

/**
 * Marks the installation for purge in 24 h, revokes its agents with reason
 * uninstalled (their AgentDOs interrupt accepted runs and close the socket),
 * drops its cached tokens and cancels its pending runs.
 */
async function onDeleted(env: Env, installationId: number, now: number): Promise<void> {
	await markDeleted(env.DB, installationId, now, now + PURGE_GRACE_MS);
	const t = tenantDb(env.DB, installationId);
	for (const agent of await listAgents(t)) {
		if (agent.revoked_at !== null) continue;
		try {
			await revokeAgent(env, agent.agent_id, "uninstalled");
		} catch (err) {
			reportError(err, { task: "installation_deleted", installation_id: installationId, agent_id: agent.agent_id });
		}
	}
	invalidateInstallation(installationId);
	await cancelOpenRuns(t, now);
}

export async function onInstallationEvent(env: Env, payload: InstallationPayload): Promise<void> {
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const id = payload.installation.id;
	switch (payload.action) {
		case "created":
			// The created payload lists repos without default_branch, so the sync reads them through the installation token.
			await syncInstallation(env, githubClient(env), payload.installation, now);
			return;
		case "new_permissions_accepted":
			await setInstallationPermissions(env.DB, id, payload.installation.permissions);
			return;
		case "deleted":
			await onDeleted(env, id, now);
			return;
		case "suspend":
			// Later triggers go pending with reason suspended; the cached tokens no longer work.
			await markSuspended(env.DB, id, now);
			invalidateInstallation(id);
			return;
		case "unsuspend":
			await markSuspended(env.DB, id, null);
			return;
	}
}

/**
 * Stores the added repos and binds their checks to the agent
 * pickAgentForNewRepos chooses for the sender, if any.
 */
async function onReposAdded(env: Env, payload: InstallationRepositoriesPayload): Promise<void> {
	const added = new Set(payload.repositories_added.map((r) => r.id));
	if (added.size === 0) return;
	const t = tenantDb(env.DB, payload.installation.id);
	// The webhook lists repos without default_branch, so they are read through the installation token.
	const listed = (await listInstallationRepos(await githubClient(env).installation(payload.installation.id))).filter((r) => added.has(r.id));
	await upsertRepos(
		t,
		listed.map((r) => ({ repo_id: r.id, full_name: r.full_name, default_branch: r.default_branch })),
	);
	const agentId = await pickAgentForNewRepos(t, payload.sender.id);
	if (agentId === null) return;
	await bindRepos(
		t,
		listed.map((r) => r.id),
		"checks",
		agentId,
	);
}

/** Forgets the removed repos and tells each channel that watched any of them, once. */
async function onReposRemoved(env: Env, payload: InstallationRepositoriesPayload): Promise<void> {
	const removed = payload.repositories_removed;
	if (removed.length === 0) return;
	const t = tenantDb(env.DB, payload.installation.id);
	const ids = removed.map((r) => r.id);
	const names = new Map(removed.map((r) => [r.id, r.full_name]));
	const channels = new Map<string, { teamId: string; channelId: string; repos: string[] }>();
	for (const watch of await listWatchesForRepos(t, ids)) {
		const key = `${watch.team_id}:${watch.channel_id}`;
		const channel = channels.get(key) ?? { teamId: watch.team_id, channelId: watch.channel_id, repos: [] };
		channel.repos.push(names.get(watch.repo_id) ?? String(watch.repo_id));
		channels.set(key, channel);
	}
	await removeRepos(t, ids);
	for (const { teamId, channelId, repos } of channels.values()) {
		try {
			await slackApiFireAndForget(env, teamId, "chat.postMessage", { channel: channelId, text: S.slack.repoRemoved(repos) });
		} catch (err) {
			reportError(err, { task: "repos_removed", installation_id: payload.installation.id, team_id: teamId });
		}
	}
}

export async function onInstallationRepositories(env: Env, payload: InstallationRepositoriesPayload): Promise<void> {
	await onReposAdded(env, payload);
	await onReposRemoved(env, payload);
}

registerHandler("installation", async (env, payload) => {
	if (!isInstallationPayload(payload)) return { status: "dropped", note: "malformed_payload" };
	await onInstallationEvent(env, payload);
	return { status: "processed" };
});

registerHandler("installation_repositories", async (env, payload) => {
	if (!isInstallationRepositoriesPayload(payload)) return { status: "dropped", note: "malformed_payload" };
	const installation = await getInstallation(env.DB, payload.installation.id);
	if (!installation) return { status: "dropped", note: "unknown_installation" };
	if (installation.deleted_at !== null) return { status: "dropped", note: "deleted" };
	await onInstallationRepositories(env, payload);
	return { status: "processed" };
});
