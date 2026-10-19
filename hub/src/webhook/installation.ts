// GitHub `installation` webhook. created syncs the installation and its repos
// (shared with the install callback); new_permissions_accepted stores the new
// permissions. deleted, suspend and unsuspend land with M1-23.

import { setInstallationPermissions, upsertInstallation } from "../db/installations";
import { listRepos, removeRepos, upsertRepos } from "../db/repos";
import { tenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { listInstallationRepos } from "../github/api";
import { GitHubClient } from "../github/client";
import { defaultFetcher } from "../http";
import { registerHandler } from "./handlers";

export interface InstallationAccount {
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

/** True for an installation on a User or Organization account, with string permissions. */
export function isSyncableInstallation(value: unknown): value is SyncableInstallation {
	return (
		isObject(value) &&
		Number.isSafeInteger(value.id) &&
		isObject(value.account) &&
		typeof value.account.login === "string" &&
		(value.account.type === "User" || value.account.type === "Organization") &&
		isObject(value.permissions) &&
		Object.values(value.permissions).every((p) => typeof p === "string")
	);
}

function isInstallationPayload(value: unknown): value is InstallationPayload {
	return isObject(value) && typeof value.action === "string" && isSyncableInstallation(value.installation);
}

/**
 * Upserts the installation (a reinstall clears a pending purge), stores its
 * permissions, and replaces its repos with the list its installation token
 * sees. Idempotent.
 */
export async function syncInstallation(env: Env, github: GitHubClient, inst: SyncableInstallation, now: number): Promise<void> {
	await upsertInstallation(env.DB, { id: inst.id, account_login: inst.account.login, account_type: inst.account.type, created_at: now });
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

export async function onInstallationEvent(env: Env, payload: InstallationPayload): Promise<void> {
	const clock = env.__TEST_CLOCK ?? systemClock;
	switch (payload.action) {
		case "created":
			// The created payload lists repos without default_branch, so the sync reads them through the installation token.
			await syncInstallation(env, new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, () => clock.now()), payload.installation, clock.now());
			return;
		case "new_permissions_accepted":
			await setInstallationPermissions(env.DB, payload.installation.id, payload.installation.permissions);
			return;
	}
}

registerHandler("installation", async (env, payload) => {
	if (!isInstallationPayload(payload)) return { status: "dropped", note: "malformed_payload" };
	await onInstallationEvent(env, payload);
	return { status: "processed" };
});
