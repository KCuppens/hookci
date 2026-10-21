// /hookci export: a signed link, valid 15 minutes, to a JSON copy of what
// HookCI stores about one Slack user: the GitHub link, the author mappings
// and the runs that GitHub user authored within the retention window.

import { base64url, hmacSha256, timingSafeEqual } from "../crypto";
import { type AccountExport, exportAccountOfGithubUser } from "../db/accounts";
import { type AuthorMappingRow, listAuthorMappings, listAuthoredRuns } from "../db/user-data";
import { getUserLink, listLinkedInstallationIds } from "../db/workspaces";
import type { Env } from "../env";
import { HubError } from "../errors";
import { QUOTAS } from "../quotas";
import { ulid } from "../ulid";

export const EXPORT_TTL_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const SLACK_ID = /^[A-Z0-9]+$/;

export interface ExportedRun {
	installation_id: number;
	repo: string | null;
	sha: string;
	ref: string;
	event: string;
	pr_number: number | null;
	target: string;
	attempt: number;
	state: string;
	reason: string | null;
	commit_title: string | null;
	started_at: number | null;
	finished_at: number | null;
	duration_ms: number | null;
}

export interface UserDataExport {
	v: 1;
	generated_at: string;
	slack: { team_id: string; user_id: string };
	github_link: { github_user_id: number; github_login: string; linked_at: number } | null;
	author_mappings: AuthorMappingRow[];
	runs: ExportedRun[];
	/** The email account linked to the GitHub user; null when there is none (always, when ACCOUNTS_ENABLED is off). No password hash or token is exported. */
	account: AccountExport | null;
}

async function sign(env: Env, data: string): Promise<string> {
	return base64url(await hmacSha256(env.STATE_SIGNING_KEY, `export.${data}`));
}

/** HUB_ORIGIN/v1/export?token=<team>.<user>.<expires_at>.<signature>, valid 15 minutes from now. */
export async function issueExportUrl(env: Env, teamId: string, slackUserId: string, now: number): Promise<string> {
	const data = `${teamId}.${slackUserId}.${now + EXPORT_TTL_MS}`;
	return `${env.HUB_ORIGIN}/v1/export?token=${encodeURIComponent(`${data}.${await sign(env, data)}`)}`;
}

/** The team and user an export token names; throws export_token_invalid (403) for a bad signature or shape and export_token_expired (410). */
export async function verifyExportToken(env: Env, token: string, now: number): Promise<{ teamId: string; slackUserId: string }> {
	const [teamId = "", slackUserId = "", expires = "", signature = "", ...rest] = token.split(".");
	if (rest.length > 0 || !SLACK_ID.test(teamId) || !SLACK_ID.test(slackUserId) || !/^\d+$/.test(expires)) {
		throw new HubError("export_token_invalid", 403, "export token is malformed");
	}
	if (!timingSafeEqual(signature, await sign(env, `${teamId}.${slackUserId}.${expires}`))) {
		throw new HubError("export_token_invalid", 403, "export token signature does not match");
	}
	if (Number(expires) <= now) throw new HubError("export_token_expired", 410, `export token expired at ${expires}`);
	return { teamId, slackUserId };
}

/** Everything HookCI stores about the Slack user in the team; runs are those of the linked GitHub login in the last retentionDays. */
export async function collectUserData(env: Env, teamId: string, slackUserId: string, now: number): Promise<UserDataExport> {
	const link = await getUserLink(env.DB, teamId, slackUserId);
	const runs: ExportedRun[] = [];
	if (link) {
		const minTriggerId = `${ulid(now - QUOTAS.retentionDays * DAY_MS).slice(0, 10)}${"0".repeat(16)}`;
		for (const installationId of await listLinkedInstallationIds(env.DB, teamId)) {
			for (const run of await listAuthoredRuns(env.DB, installationId, link.github_login, minTriggerId)) {
				runs.push({
					installation_id: run.installation_id,
					repo: run.full_name,
					sha: run.sha,
					ref: run.ref,
					event: run.event,
					pr_number: run.pr_number,
					target: run.env === null ? "checks" : `deploy:${run.env}`,
					attempt: run.attempt,
					state: run.state,
					reason: run.reason,
					commit_title: run.commit_title,
					started_at: run.started_at,
					finished_at: run.finished_at,
					duration_ms: run.duration_ms,
				});
			}
		}
	}
	return {
		v: 1,
		generated_at: new Date(now).toISOString(),
		slack: { team_id: teamId, user_id: slackUserId },
		github_link: link && { github_user_id: link.github_user_id, github_login: link.github_login, linked_at: link.created_at },
		author_mappings: await listAuthorMappings(env.DB, teamId, slackUserId),
		runs,
		account: link ? await exportAccountOfGithubUser(env.DB, link.github_user_id) : null,
	};
}
