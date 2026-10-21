// /hookci me: shows the caller's GitHub link or offers a one-use button to
// create it. /hookci me unlink removes the caller's link in this workspace.

import { deleteUserLink } from "../../db/workspaces";
import { systemClock } from "../../do/clock";
import { getLinkedUser, issueLinkUrl } from "../../identity/link";
import { S } from "../../strings";
import { actions, linkButton, section } from "../blocks";
import { registerCommand } from "../registry";
import { commandArgs, ephemeral } from "./common";

registerCommand("me", async ({ env, teamId, userId, text }) => {
	const linked = await getLinkedUser(env, teamId, userId);
	if (commandArgs(text)[0]?.toLowerCase() === "unlink") {
		if (!linked) return ephemeral(S.slack.notLinkedNothing);
		await deleteUserLink(env.DB, teamId, userId);
		return ephemeral(S.slack.unlinked(linked.githubLogin));
	}
	if (linked) return ephemeral(S.slack.linkedAs(linked.githubLogin));
	const url = await issueLinkUrl(env, teamId, userId, (env.__TEST_CLOCK ?? systemClock).now());
	return ephemeral(S.slack.linkPrompt, [section(S.slack.linkPrompt), actions(linkButton(S.slack.linkButton, url, "primary"))]);
});
