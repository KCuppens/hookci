// In-isolate cache of the channels the bot is in, by name, in each Slack
// workspace, for the .zeroci.yml notify.slack override, which names its
// channel. An entry lives at most 10 minutes, so a channel created, renamed or
// joined later is found within that time.

import type { Env } from "../env";
import { slackApi } from "./api";

export const CHANNELS_TTL_MS = 600_000;

interface TeamChannels {
	/** Channel ids by name. */
	byName: Map<string, string>;
	expiresAt: number;
	/** Names already reported unusable while this entry lives. */
	reported: Set<string>;
}

const teams = new Map<string, TeamChannels>();
/** The listing in flight for each team, which every concurrent cache miss waits on. */
const listings = new Map<string, Promise<TeamChannels>>();

export type ChannelLookup = { kind: "found"; id: string } | { kind: "unusable"; firstReport: boolean };

/**
 * The channel named name in teamId, if the bot is in it and so can post
 * there. An unusable name has firstReport true once per cache entry, so the
 * caller logs it once rather than on every run update.
 */
export async function findChannel(env: Env, teamId: string, name: string, now: number): Promise<ChannelLookup> {
	let entry = teams.get(teamId);
	if (!entry || entry.expiresAt <= now) entry = await loadTeam(env, teamId, now);
	const id = entry.byName.get(name);
	if (id !== undefined) return { kind: "found", id };
	const firstReport = !entry.reported.has(name);
	entry.reported.add(name);
	return { kind: "unusable", firstReport };
}

/** Caches teamId's channels from one listing, shared by every lookup that misses while it runs. */
function loadTeam(env: Env, teamId: string, now: number): Promise<TeamChannels> {
	const inFlight = listings.get(teamId);
	if (inFlight) return inFlight;
	const listing = listMemberChannels(env, teamId)
		.then((byName) => {
			const entry: TeamChannels = { byName, expiresAt: now + CHANNELS_TTL_MS, reported: new Set() };
			teams.set(teamId, entry);
			return entry;
		})
		.finally(() => listings.delete(teamId));
	listings.set(teamId, listing);
	return listing;
}

/** Every unarchived public and private channel the bot is in, by name, paging through users.conversations. */
async function listMemberChannels(env: Env, teamId: string): Promise<TeamChannels["byName"]> {
	const byName: TeamChannels["byName"] = new Map();
	let cursor = "";
	do {
		const res = await slackApi(env, teamId, "users.conversations", {
			types: "public_channel,private_channel",
			exclude_archived: true,
			limit: 999,
			...(cursor === "" ? {} : { cursor }),
		});
		for (const c of Array.isArray(res.channels) ? res.channels : []) {
			if (typeof c === "object" && c !== null && "id" in c && typeof c.id === "string" && "name" in c && typeof c.name === "string") {
				byName.set(c.name, c.id);
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
	listings.clear();
}
