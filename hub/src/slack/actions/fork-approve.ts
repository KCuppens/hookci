// The "Approve run" button on a gated fork run. Its value binds the run to
// the head SHA it was gated on: `<runId>:<headSha>`.

import { getRepo } from "../../db/repos";
import { getRun } from "../../db/runs";
import { tenantDb } from "../../db/tenant";
import { listLinkedInstallationIds } from "../../db/workspaces";
import { HubError } from "../../errors";
import { approveForkRun } from "../../forks/gate";
import { requireLinkedUser } from "../../identity/link";
import { S } from "../../strings";
import { ephemeral } from "../commands/common";
import { registerAction } from "../registry";
import { commandGitHub, requirePermission } from "../resolve";

const REPLY = { dispatched: S.forks.approved, stale: S.forks.staleApproval, already_used: S.forks.alreadyApproved, not_gated: S.forks.notGated } as const;

registerAction("fork:approve", async ({ env, teamId, userId, value }) => {
	const user = await requireLinkedUser(env, teamId, userId);
	const [runId = "", headSha = ""] = value.split(":");
	for (const installationId of await listLinkedInstallationIds(env.DB, teamId)) {
		const t = tenantDb(env.DB, installationId);
		const run = await getRun(t, runId);
		const repo = run && (await getRepo(t, run.repo_id));
		if (!repo) continue;
		try {
			await requirePermission(env, commandGitHub(env), installationId, repo.full_name, user.githubLogin, "write");
		} catch (err) {
			if (err instanceof HubError && err.code === "forbidden") return ephemeral(S.forks.notAllowed);
			throw err;
		}
		const outcome = await approveForkRun(env, { installationId, runId, headSha, approverGithubId: user.githubUserId, approverLogin: user.githubLogin, via: "slack" });
		return ephemeral(REPLY[outcome]);
	}
	return ephemeral(S.forks.notGated);
});
