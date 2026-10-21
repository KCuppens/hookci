// /hookci delete-my-data deletes what HookCI stores about the caller in
// this workspace; it needs no GitHub link, so an unlinked user can still
// clear author mappings. /hookci export hands the linked caller a 15-minute
// link to a JSON copy of their data.

import { deleteSlackUserData } from "../../db/user-data";
import { systemClock } from "../../do/clock";
import { collectUserData, issueExportUrl } from "../../identity/export";
import { requireLinkedUser } from "../../identity/link";
import { QUOTAS } from "../../quotas";
import { S } from "../../strings";
import { actions, linkButton, section } from "../blocks";
import { registerCommand } from "../registry";
import { ephemeral } from "./common";

registerCommand("delete-my-data", async ({ env, teamId, userId }) => {
	const deleted = await deleteSlackUserData(env.DB, teamId, userId);
	return ephemeral(S.slack.deletedData(deleted.links, deleted.authorMappings, deleted.authorCache));
});

registerCommand("export", async ({ env, teamId, userId }) => {
	const user = await requireLinkedUser(env, teamId, userId);
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const data = await collectUserData(env, teamId, userId, now);
	const text = S.slack.exportSummary(user.githubLogin, data.author_mappings.length, data.runs.length, QUOTAS.retentionDays);
	const url = await issueExportUrl(env, teamId, userId, now);
	return ephemeral(text, [section(text), actions(linkButton(S.slack.exportButton, url))]);
});
