// The failure alert's View log button: value `<run_id>:<job>`. Answers the
// caller alone with a fresh signed link once they prove read access to the
// run's repo, so the link a channel member gets is never older than 15 minutes.

import { getRepo } from "../../db/repos";
import { getRunOwner } from "../../db/runs";
import { tenantDb } from "../../db/tenant";
import { listLinkedInstallationIds } from "../../db/workspaces";
import { HubError } from "../../errors";
import { requireLinkedUser } from "../../identity/link";
import { signLogUrl } from "../../logs/sign";
import { logEvent } from "../../observability";
import { S } from "../../strings";
import { ephemeral } from "../commands/common";
import { registerAction } from "../registry";
import { commandGitHub, requirePermission } from "../resolve";

registerAction("log:view", async ({ env, teamId, userId, value }) => {
	const user = await requireLinkedUser(env, teamId, userId);
	const sep = value.indexOf(":");
	const runId = value.slice(0, sep);
	const job = value.slice(sep + 1);
	const owner = sep > 0 ? await getRunOwner(env.DB, runId) : null;
	const linked = owner !== null && (await listLinkedInstallationIds(env.DB, teamId)).includes(owner.installation_id);
	const repo = owner && linked ? await getRepo(tenantDb(env.DB, owner.installation_id), owner.repo_id) : null;
	if (!owner || !repo) {
		logEvent("tenant_denied", { team_id: teamId, slack_user_id: userId, run_id: runId, reason: owner ? "run_not_linked" : "unknown_run" });
		throw new HubError("forbidden", 403, `run ${runId} is not in an installation linked to ${teamId}`);
	}
	await requirePermission(env, commandGitHub(env), owner.installation_id, repo.full_name, user.githubLogin, "read");
	return ephemeral(S.slack.logLink(await signLogUrl(env, runId, job)));
});
