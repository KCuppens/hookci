// In-isolate cache of each Slack workspace's channels by name, for the
// .hookci.yml notify.slack override, which names its channel. An entry lives
// at most 10 minutes, so a channel created, renamed or joined later is found
// within that time.

import type { Env } from "../env";
import { slackApi } from "./api";

export const CHANNELS_TTL_MS = 600_000;

interface TeamChannels {
	byName: Map<string, { id: string; isMember: boolean }>;
	expiresAt: number;
	/** Names already reported unusable while this entry lives. */
	reported: Set<string>;
}

const teams = new Map<string, TeamChannels>();

export type ChannelLookup =
	| { kind: "found"; id: string }
	| { kind: "unusable"; reason: "not_found" | "not_member"; firstReport: boolean };

/**
 * The channel named name in teamId, which the bot must be in to post. An
 * unusable name has firstReport true once per cache entry, so the caller
 * logs it once rather than on every run update.
 */
export async function findChannel(env: Env, teamId: string, name: string, now: number): Promise<ChannelLookup> {
	let entry = teams.get(teamId);
	if (!entry || entry.expiresAt <= now) {
		entry = { byName: await listChannels(env, teamId), expiresAt: now + CHANNELS_TTL_MS, reported: new Set() };
		teams.set(teamId, entry);
	}
	const channel = entry.byName.get(name);
	if (channel?.isMember) return { kind: "found", id: channel.id };
	const firstReport = !entry.reported.has(name);
	entry.reported.add(name);
	return { kind: "unusable", reason: channel ? "not_member" : "not_found", firstReport };
}

/** Every unarchived public and private channel the token can see, by name, paging through conversations.list. */
async function listChannels(env: Env, teamId: string): Promise<TeamChannels["byName"]> {
	const byName: TeamChannels["byName"] = new Map();
	let cursor = "";
	do {
		const res = await slackApi(env, teamId, "conversations.list", {
			types: "public_channel,private_channel",
			exclude_archived: true,
			limit: 1000,
			...(cursor === "" ? {} : { cursor }),
		});
		for (const c of Array.isArray(res.channels) ? res.channels : []) {
			if (typeof c === "object" && c !== null && "id" in c && typeof c.id === "string" && "name" in c && typeof c.name === "string") {
				byName.set(c.name, { id: c.id, isMember: "is_member" in c && c.is_member === true });
			}
		}
		const meta = res.response_metadata;
		cursor = typeof meta === "object" && meta !== null && "next_cursor" in meta && typeof meta.next_cursor === "string" ? meta.next_cursor : "";
	} while (cursor !== "");
	return byName;
}

/** Tests only: forgets every cached workspace. */
export function resetChannelCacheForTests(): void {
	teams.clear();
}
