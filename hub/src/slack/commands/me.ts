// /zeroci me: shows the caller's GitHub link or offers a one-use button to
// create it. /zeroci me unlink removes the caller's link in this workspace.

import { deleteUserLink } from "../../db/workspaces";
import { systemClock } from "../../do/clock";
import { getLinkedUser, issueLinkUrl } from "../../identity/link";
import { S } from "../../strings";
import { actions, linkButton, section } from "../blocks";
import { registerCommand } from "../registry";

registerCommand("me", async ({ env, teamId, userId, text }) => {
	const linked = await getLinkedUser(env, teamId, userId);
	if (text.trim().split(/\s+/)[1]?.toLowerCase() === "unlink") {
		if (!linked) return { response_type: "ephemeral", text: S.slack.notLinkedNothing };
		await deleteUserLink(env.DB, teamId, userId);
		return { response_type: "ephemeral", text: S.slack.unlinked(linked.githubLogin) };
	}
	if (linked) return { response_type: "ephemeral", text: S.slack.linkedAs(linked.githubLogin) };
	const url = await issueLinkUrl(env, teamId, userId, (env.__TEST_CLOCK ?? systemClock).now());
	return {
		response_type: "ephemeral",
		text: S.slack.linkPrompt,
		blocks: [section(S.slack.linkPrompt), actions(linkButton(S.slack.linkButton, url, "primary"))],
	};
});
