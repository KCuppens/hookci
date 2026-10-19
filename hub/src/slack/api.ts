// The Slack Web API client for one workspace's bot token. Arguments go
// form-encoded, which every Web API method accepts (read methods such as
// conversations.info take no JSON bodies); objects and arrays such as blocks
// are sent as JSON strings.

import type { Env } from "../env";
import { HubError } from "../errors";
import { defaultFetcher, type Fetcher } from "../http";
import { getBotToken } from "./tokens";

export type SlackApiResult = { ok: true } & Record<string, unknown>;

/**
 * Calls `https://slack.com/api/<method>` as team teamId's bot. Throws
 * slack_api (502) with Slack's error code as message when Slack answers
 * `ok: false`, or with `http <status>` when the answer is not JSON.
 */
export async function slackApi(
	env: Env,
	teamId: string,
	method: string,
	args: Record<string, unknown>,
	fetcher: Fetcher = env.__TEST_FETCHER ?? defaultFetcher,
): Promise<SlackApiResult> {
	const form = new URLSearchParams();
	for (const [name, value] of Object.entries(args)) {
		if (value === undefined) continue;
		form.set(name, typeof value === "string" ? value : JSON.stringify(value));
	}
	const res = await fetcher(`https://slack.com/api/${method}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${await getBotToken(env, teamId)}`, "Content-Type": "application/x-www-form-urlencoded" },
		body: form,
	});
	let body: { ok?: unknown; error?: unknown };
	try {
		body = await res.json<{ ok?: unknown; error?: unknown }>();
	} catch {
		throw new HubError("slack_api", 502, `http ${res.status}`);
	}
	if (body.ok !== true) throw new HubError("slack_api", 502, typeof body.error === "string" ? body.error : `http ${res.status}`);
	return body as SlackApiResult;
}
