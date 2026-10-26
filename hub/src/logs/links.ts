// Stable log links and who may follow them. Messages, Checks and deploy
// alerts carry stableLogLink, which never expires; following it mints a
// short-lived signed viewer URL (logs/signing.ts) for whoever logAccess lets
// through, from the browser (routes/log-links.ts) or the Slack View logs
// button (slack/view-logs.ts).

import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { getCollaboratorPermission, getRepository } from "../github/api";
import { GitHubClient } from "../github/client";
import { defaultFetcher } from "../http";

/** HUB_ORIGIN/runs/<runId>/logs?job=<job>: a log link safe to store in Slack, Checks and deploy alerts. */
export function stableLogLink(env: Pick<Env, "HUB_ORIGIN">, runId: string, job: string): string {
	return `${env.HUB_ORIGIN}/runs/${encodeURIComponent(runId)}/logs?job=${encodeURIComponent(job)}`;
}

/** HUB_ORIGIN/<installationId>/runs/<runId>: the dashboard's run page, which signs in with GitHub like the log link does. */
export function runPageLink(env: Pick<Env, "HUB_ORIGIN">, installationId: number, runId: string): string {
	return `${env.HUB_ORIGIN}/${installationId}/runs/${encodeURIComponent(runId)}`;
}

/** "sign_in": the repo is private and nobody is signed in. */
export type LogAccess = "allowed" | "denied" | "sign_in";

/**
 * Whether GitHub user login (null when nobody is signed in) may read the logs
 * of repo repoId in installationId: anyone on a public repo, anyone with a
 * role on a private one. Visibility and role are asked of GitHub on every
 * call with the installation token, never cached, so a revoked collaborator
 * loses access at once. A repo the installation no longer sees is denied.
 */
export async function logAccess(env: Env, installationId: number, repoId: number, login: string | null): Promise<LogAccess> {
	const clock = env.__TEST_CLOCK ?? systemClock;
	const github = new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, () => clock.now());
	const inst = await github.installation(installationId);
	const repo = await getRepository(inst, repoId);
	if (!repo) return "denied";
	if (!repo.private) return "allowed";
	if (login === null) return "sign_in";
	return (await getCollaboratorPermission(inst, repo.owner.login, repo.name, login)) === "none" ? "denied" : "allowed";
}
