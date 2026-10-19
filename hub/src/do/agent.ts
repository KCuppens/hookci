import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/** One per paired agent (`idFromName("agent:" + agentId)`). Not implemented yet. */
export class AgentDO extends DurableObject<Env> {
	override async fetch(): Promise<Response> {
		return new Response("not implemented", { status: 501 });
	}
}
