// GET /install: the agent installer, piped to sh by
// `curl -fsSL https://<hub>/install | sh`.

import type { Context } from "hono";
import script from "../../static/install.sh";
import type { Env } from "../env";

export function install(c: Context<{ Bindings: Env }>): Response {
	const body = script.replaceAll("__HUB_ORIGIN__", c.env.HUB_ORIGIN).replaceAll("__HUB_VERSION__", c.env.HUB_VERSION);
	return new Response(body, {
		headers: {
			"content-type": "text/x-shellscript; charset=utf-8",
			"cache-control": "public, max-age=300",
		},
	});
}
