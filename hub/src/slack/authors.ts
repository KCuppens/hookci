// Which Slack user wrote a commit, for the failure alert's one mention:
// the installation's author_map first, then users.lookupByEmail with the
// commit email. Lookups are cached in author_cache for 24 h, misses too,
// under the login or a SHA-256 of the email, never the raw address.

import { tenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { logEvent } from "../observability";
import { slackApi } from "./api";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** GitHub's private-email addresses, which no Slack account has. */
export function isNoreplyEmail(email: string): boolean {
	const e = email.trim().toLowerCase();
	return e === "noreply@github.com" || e.endsWith("@users.noreply.github.com");
}

async function emailKey(email: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
	return `email:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The Slack user id of the commit author in team teamId, or null when unknown. */
export async function resolveAuthor(
	env: Env,
	installationId: number,
	teamId: string,
	author: { login: string; email?: string },
): Promise<string | null> {
	const t = tenantDb(env.DB, installationId);
	const mapped = await t.first<{ slack_user_id: string }>(
		"SELECT slack_user_id FROM author_map WHERE installation_id = ?1 AND team_id = ?2 AND github_login = ?3",
		teamId,
		author.login,
	);
	if (mapped) return mapped.slack_user_id;

	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const loginKey = `login:${author.login}`;
	const email = author.email && !isNoreplyEmail(author.email) ? author.email : undefined;
	const key = email ? await emailKey(email) : loginKey;
	const cached = await t.first<{ slack_user_id: string | null }>(
		"SELECT slack_user_id FROM author_cache WHERE installation_id = ?1 AND team_id = ?2 AND key = ?3 AND expires_at > ?4",
		teamId,
		key,
		now,
	);
	if (cached) return cached.slack_user_id || null;
	if (!email) return null;

	let found: string | null;
	try {
		const { user } = await slackApi(env, teamId, "users.lookupByEmail", { email });
		found = typeof user === "object" && user !== null && "id" in user && typeof user.id === "string" ? user.id : null;
	} catch (err) {
		if (!(err instanceof HubError && err.message === "users_not_found")) {
			logEvent("slack_author_lookup_failed", { teamId, error: err instanceof Error ? err.message : String(err) });
			return null;
		}
		found = null;
	}
	// A hit is also cached by login, so the run updates that carry no email
	// still find it; a miss is not, as another email of the login may match.
	for (const k of found ? [key, loginKey] : [key]) {
		await t.run(
			`INSERT INTO author_cache (installation_id, team_id, key, slack_user_id, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
			ON CONFLICT (installation_id, team_id, key) DO UPDATE SET slack_user_id = excluded.slack_user_id, expires_at = excluded.expires_at`,
			teamId,
			k,
			found ?? "",
			now + CACHE_TTL_MS,
		);
	}
	return found;
}
