// The View logs button on run messages and failure alerts: value
// `<run_id>:<job>`. Answers the clicker alone with a fresh signed viewer URL
// once logs/links.ts logAccess lets their linked GitHub account read the
// run's repo, so a link a channel member gets is never older than 15 minutes.

import { hitIpRate } from "../db/ip-rate";
import { getJob, getRunOwner } from "../db/runs";
import { tenantDb } from "../db/tenant";
import { listLinkedInstallationIds } from "../db/workspaces";
import { systemClock } from "../do/clock";
import { getLinkedUser } from "../identity/link";
import { logAccess } from "../logs/links";
import { signLogUrl } from "../logs/signing";
import { logEvent } from "../observability";
import { QUOTAS } from "../quotas";
import { S } from "../strings";
import { type ButtonElement, button } from "./blocks";
import { ephemeral } from "./commands/common";
import { registerAction } from "./registry";

export const VIEW_LOGS_ACTION = "zeroci_view_logs";

export function viewLogsButton(runId: string, job: string): ButtonElement {
	return button(VIEW_LOGS_ACTION, S.slack.viewLogs, `${runId}:${job}`);
}

registerAction(VIEW_LOGS_ACTION, async ({ env, teamId, userId, value }) => {
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	if (!(await hitIpRate(env.DB, `slackcmd:${teamId}`, QUOTAS.slackCmdsPerMin, 60_000, now)).ok) return ephemeral(S.slack.slowDown);
	const user = await getLinkedUser(env, teamId, userId);
	if (!user) return ephemeral(S.slack.viewLogsNotLinked);
	const sep = value.indexOf(":");
	const runId = value.slice(0, sep);
	const job = value.slice(sep + 1);
	const owner = sep > 0 ? await getRunOwner(env.DB, runId) : null;
	const linked = owner !== null && (await listLinkedInstallationIds(env.DB, teamId)).includes(owner.installation_id);
	const found = owner !== null && linked && (await getJob(tenantDb(env.DB, owner.installation_id), runId, job)) !== null;
	if (!owner || !found) {
		logEvent("tenant_denied", { team_id: teamId, slack_user_id: userId, run_id: runId, reason: !owner ? "unknown_run" : linked ? "unknown_job" : "run_not_linked" });
		return ephemeral(S.slack.viewLogsNoAccess);
	}
	if ((await logAccess(env, owner.installation_id, owner.repo_id, user.githubLogin)) !== "allowed") {
		logEvent("tenant_denied", { team_id: teamId, slack_user_id: userId, run_id: runId, reason: "log_access" });
		return ephemeral(S.slack.viewLogsNoAccess);
	}
	return ephemeral(S.slack.logLink(await signLogUrl(env, { installationId: owner.installation_id, runId, job }, new Date(now))));
});
