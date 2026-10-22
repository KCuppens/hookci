// /hookci retry <owner/repo> [sha]: runs the repo's latest run, or the
// latest run of the commit, again as the next attempt through the bound
// agent's AgentDO. A fork pull request's attempt passes the fork gate like a
// new fork run: it waits as gated until a writer approves it. No trigger is
// stored, so the trigger is rebuilt from the D1 run row, the repo row and, for
// pull requests, the pull request on GitHub.

import { findLatestRun } from "../../db/runs";
import { tenantDb } from "../../db/tenant";
import { requireLinkedUser } from "../../identity/link";
import { retryRun } from "../../runs/retry";
import { S } from "../../strings";
import { registerCommand } from "../registry";
import { requireRepoAccess } from "../resolve";
import { commandArgs, ephemeral } from "./common";

const SHA = /^[0-9a-f]{7,40}$/i;

registerCommand("retry", async ({ env, teamId, userId, text }) => {
	const user = await requireLinkedUser(env, teamId, userId);
	const [fullName, sha, ...rest] = commandArgs(text);
	if (!fullName || rest.length > 0 || (sha !== undefined && !SHA.test(sha))) return ephemeral(S.slack.usage("/hookci retry <owner/repo> [sha]"));
	const { repo, gh } = await requireRepoAccess(env, teamId, user, fullName, "write");
	const t = tenantDb(env.DB, repo.installationId);
	const run = await findLatestRun(t, repo.repoId, sha);
	if (!run) return ephemeral(S.slack.retryNoRun(repo.fullName, sha));
	const outcome = await retryRun(env, gh, repo, run);
	const shortSha = run.sha.slice(0, 7);
	const attempt = run.attempt + 1;
	switch (outcome.kind) {
		case "no_agent":
			return ephemeral(S.slack.retryNoAgent(repo.fullName, outcome.target));
		case "fork_never":
			return ephemeral(S.slack.retryForkNever(repo.fullName, shortSha));
		case "gated":
			return ephemeral(S.slack.retryGated(repo.fullName, shortSha, attempt));
		case "duplicate":
			return ephemeral(S.slack.retryDuplicate(repo.fullName, shortSha, attempt));
		case "offline":
			return ephemeral(S.slack.retryOffline(repo.fullName, shortSha, attempt));
		case "retried":
			return ephemeral(S.slack.retried(repo.fullName, shortSha, attempt, outcome.state));
	}
});
