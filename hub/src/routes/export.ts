// GET /v1/export?token=: the JSON copy of one Slack user's data behind the
// signed link /hookci export hands out. Never cached.

import type { Context } from "hono";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { collectUserData, verifyExportToken } from "../identity/export";

type AppContext = Context<{ Bindings: Env }>;

const NO_STORE = { "Cache-Control": "no-store" };

export async function exportData(c: AppContext): Promise<Response> {
	const env = c.env;
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	let user: { teamId: string; slackUserId: string };
	try {
		user = await verifyExportToken(env, c.req.query("token") ?? "", now);
	} catch (err) {
		if (err instanceof HubError) return Response.json({ error: err.code }, { status: err.status, headers: NO_STORE });
		throw err;
	}
	return Response.json(await collectUserData(env, user.teamId, user.slackUserId, now), {
		headers: { ...NO_STORE, "Content-Disposition": 'attachment; filename="hookci-export.json"' },
	});
}
