// GET /status: the public status page, drawn from the health checks the cron records.

import type { Context } from "hono";
import { loadStatusRows } from "../db/status";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { statusPage } from "../pages/status";
import { summarize, windowStartDay } from "../status-summary";

type AppContext = Context<{ Bindings: Env }>;

/** The page changes at most every cron tick (5 minutes), so a minute of caching is invisible. */
const CACHE_CONTROL = "public, max-age=60";

export async function statusRoute(c: AppContext): Promise<Response> {
	const now = (c.env.__TEST_CLOCK ?? systemClock).now();
	const res = await statusPage(summarize(await loadStatusRows(c.env.DB, windowStartDay(now)), now));
	res.headers.set("Cache-Control", CACHE_CONTROL);
	return res;
}
