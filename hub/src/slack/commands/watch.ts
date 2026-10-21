// /hookci watch <owner/repo> [quiet] [dm]: posts the repo's run badges in
// this channel, quiet mode and DM alerts optional, and proves it with a test
// badge. The bot must be a member of the channel.

import { tenantDb } from "../../db/tenant";
import { addWatch } from "../../db/watches";
import type { Env } from "../../env";
import { HubError } from "../../errors";
import { requireLinkedUser } from "../../identity/link";
import type { RunView } from "../../sinks/types";
import { S } from "../../strings";
import { slackApi } from "../api";
import { renderBadge } from "../badge";
import { registerCommand } from "../registry";
import { requireRepoAccess, type ResolvedRepo } from "../resolve";
import { commandArgs, ephemeral } from "./common";

const USAGE = "/hookci watch <owner/repo> [quiet] [dm]";

/** Whether the bot can post in channelId: a member of the channel, or the channel is a DM. */
async function botInChannel(env: Env, teamId: string, channelId: string): Promise<boolean> {
	try {
		const { channel } = await slackApi(env, teamId, "conversations.info", { channel: channelId });
		if (typeof channel !== "object" || channel === null) return false;
		return ("is_member" in channel && channel.is_member === true) || ("is_im" in channel && channel.is_im === true);
	} catch (err) {
		if (err instanceof HubError && err.code === "slack_api" && err.message === "channel_not_found") return false;
		throw err;
	}
}

/** The run the test badge shows: a passed checks run of the repo. */
function testRun(repo: ResolvedRepo, authorLogin: string): RunView {
	return {
		installationId: repo.installationId,
		repoId: repo.repoId,
		repo: repo.fullName,
		triggerId: "test",
		sha: "0".repeat(40),
		shortSha: "0000000",
		event: "push",
		target: "checks",
		state: "success",
		commitTitle: "HookCI test badge",
		authorLogin,
		durationMs: 124_000,
		jobs: [{ name: "test", state: "success", durationMs: 124_000 }],
	};
}

registerCommand("watch", async ({ env, teamId, userId, channelId, text }) => {
	const user = await requireLinkedUser(env, teamId, userId);
	const [fullName, ...flags] = commandArgs(text);
	const modes = flags.map((flag) => flag.toLowerCase());
	if (!fullName || modes.some((mode) => mode !== "quiet" && mode !== "dm")) return ephemeral(S.slack.usage(USAGE));
	const { repo } = await requireRepoAccess(env, teamId, user, fullName, "write");
	if (!(await botInChannel(env, teamId, channelId))) return ephemeral(S.slack.inviteFirst);
	await addWatch(tenantDb(env.DB, repo.installationId), {
		repo_id: repo.repoId,
		team_id: teamId,
		channel_id: channelId,
		notify: modes.includes("quiet") ? "quiet" : "normal",
		alert: modes.includes("dm") ? "dm" : "channel",
		created_by: userId,
	});
	const badge = renderBadge(testRun(repo, user.githubLogin), { test: true });
	await slackApi(env, teamId, "chat.postMessage", { channel: channelId, text: badge.text, blocks: badge.blocks });
	return ephemeral(S.slack.watching(repo.fullName));
});
