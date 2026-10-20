// In-isolate cache of GitHub repository roles, keyed by installation, repo
// and login. An entry lives at most 5 minutes, so a revoked collaborator
// loses access to /zeroci commands within that time. At most 1000 entries;
// the oldest goes first.

import type { RepoPermission } from "./types";

export const PERMISSION_TTL_MS = 300_000;
const MAX_ENTRIES = 1000;

const entries = new Map<string, { permission: RepoPermission; expiresAt: number }>();

/**
 * The role of login on repo through installationId: cached when fresher than
 * 5 minutes, else loaded and cached. fresh skips the cached entry and
 * replaces it.
 */
export async function cachedPermission(
	installationId: number,
	repoFullName: string,
	login: string,
	now: number,
	load: () => Promise<RepoPermission>,
	fresh = false,
): Promise<RepoPermission> {
	const key = `${installationId}:${repoFullName.toLowerCase()}:${login.toLowerCase()}`;
	const hit = entries.get(key);
	if (hit && hit.expiresAt > now && !fresh) return hit.permission;
	const permission = await load();
	entries.delete(key);
	entries.set(key, { permission, expiresAt: now + PERMISSION_TTL_MS });
	if (entries.size > MAX_ENTRIES) {
		const oldest = entries.keys().next();
		if (!oldest.done) entries.delete(oldest.value);
	}
	return permission;
}

/** Tests only: forgets every cached role. */
export function resetPermissionCacheForTests(): void {
	entries.clear();
}
