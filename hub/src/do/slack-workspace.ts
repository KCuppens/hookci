import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/** One per Slack workspace (`idFromName("team:" + teamId)`). Not implemented yet. */
export class SlackWorkspaceDO extends DurableObject<Env> {
	override async fetch(): Promise<Response> {
		return new Response("not implemented", { status: 501 });
	}
}
