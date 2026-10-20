import type { Context } from "hono";
import type { Env } from "../env";
import { hubMode } from "../policy/trust";
import { PROTOCOL_VERSIONS } from "../version";

/** The name every zeroci hub reports, so an agent can tell a hub from any other HTTPS server. */
export const HUB_NAME = "zeroci-hub";

/**
 * GET /v1/info: unauthenticated hub description that `zeroci connect` and
 * `zeroci doctor` read. Any HUB_MODE but "self_hosted" reports the shared hub.
 */
export function info(c: Context<{ Bindings: Env }>): Response {
	return Response.json(
		{
			name: HUB_NAME,
			version: c.env.HUB_VERSION,
			mode: hubMode(c.env),
			protocol_versions: PROTOCOL_VERSIONS,
			github_app: { slug: c.env.GITHUB_APP_SLUG },
			slack: { enabled: Boolean(c.env.SLACK_SIGNING_SECRET) },
		},
		{ headers: { "Cache-Control": "max-age=60" } },
	);
}
