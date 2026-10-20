// Slack workspace lifecycle: an uninstall or a revoked bot token wipes the
// token and empties the workspace's queue so nothing more is sent; the bot
// leaving a channel breaks that channel's watches.

import { callSlackDo } from "../../do/slack-workspace";
import { markWatchBroken } from "../../db/watches";
import { deactivateWorkspace, forgetWorkspaceLinks } from "../../db/workspaces";
import { registerEvent } from "../registry";

registerEvent("app_uninstalled", async (env, teamId) => {
	await deactivateWorkspace(env.DB, teamId, "uninstalled");
	await forgetWorkspaceLinks(env.DB, teamId);
	await callSlackDo(env, teamId, { path: "purge", body: {} });
});

// Only the bot token matters: the hub keeps no user (oauth) tokens.
registerEvent("tokens_revoked", async (env, teamId, event) => {
	const tokens = event.tokens;
	const bot = typeof tokens === "object" && tokens !== null ? (tokens as Record<string, unknown>).bot : undefined;
	if (!Array.isArray(bot) || bot.length === 0) return;
	await deactivateWorkspace(env.DB, teamId, "revoked");
	await callSlackDo(env, teamId, { path: "purge", body: {} });
});

for (const type of ["channel_left", "group_left"]) {
	registerEvent(type, async (env, teamId, event) => {
		if (typeof event.channel !== "string") return;
		await markWatchBroken(env.DB, teamId, event.channel, type);
	});
}
