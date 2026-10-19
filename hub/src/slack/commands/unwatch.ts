// /zeroci unwatch <owner/repo>: stops posting the repo's badges in this channel.

import { tenantDb } from "../../db/tenant";
import { removeWatch } from "../../db/watches";
import { requireLinkedUser } from "../../identity/link";
import { S } from "../../strings";
import { registerCommand } from "../registry";
import { requireRepoAccess } from "../resolve";
import { commandArgs, ephemeral } from "./common";

registerCommand("unwatch", async ({ env, teamId, userId, channelId, text }) => {
	const user = await requireLinkedUser(env, teamId, userId);
	const [fullName, ...rest] = commandArgs(text);
	if (!fullName || rest.length > 0) return ephemeral(S.slack.usage("/zeroci unwatch <owner/repo>"));
	const { repo } = await requireRepoAccess(env, teamId, user, fullName, "write");
	const removed = await removeWatch(tenantDb(env.DB, repo.installationId), repo.repoId, teamId, channelId);
	return ephemeral(removed ? S.slack.unwatched(repo.fullName) : S.slack.notWatching(repo.fullName));
});
