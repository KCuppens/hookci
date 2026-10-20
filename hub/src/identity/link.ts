// Which GitHub user a Slack user is, per workspace. A link comes from the
// /hookci me flow (or the Slack install); every permission-sensitive Slack
// handler starts with requireLinkedUser.

import { getUserLink } from "../db/workspaces";
import type { Env } from "../env";
import { HubError } from "../errors";
import { issueState } from "../oauth/state";

export interface LinkedUser {
	githubUserId: number;
	githubLogin: string;
}

/** HUB_ORIGIN/github/link/start?t=<state>: one use, valid 10 minutes, bound to this Slack user in this team. */
export async function issueLinkUrl(env: Env, teamId: string, slackUserId: string, now: number): Promise<string> {
	const { state } = await issueState(env, "github_link", { team_id: teamId, slack_user_id: slackUserId }, now);
	return `${env.HUB_ORIGIN}/github/link/start?t=${encodeURIComponent(state)}`;
}

export async function getLinkedUser(env: Env, teamId: string, slackUserId: string): Promise<LinkedUser | null> {
	const row = await getUserLink(env.DB, teamId, slackUserId);
	return row && { githubUserId: row.github_user_id, githubLogin: row.github_login };
}

/** The linked GitHub user; throws not_linked (403) when the Slack user has not run /hookci me. */
export async function requireLinkedUser(env: Env, teamId: string, slackUserId: string): Promise<LinkedUser> {
	const user = await getLinkedUser(env, teamId, slackUserId);
	if (!user) throw new HubError("not_linked", 403, `Slack user ${slackUserId} in ${teamId} has no GitHub link`);
	return user;
}
