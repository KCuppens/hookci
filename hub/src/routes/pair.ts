// POST /v1/pair/redeem: an agent trades a single-use pair token for its
// credential (`zeroci connect <pair-token>`).

import type { Context } from "hono";
import type { Env } from "../env";
import { HubError } from "../errors";
import { type RedeemInput, redeemPairToken } from "../pairing/tokens";

export async function pairRedeem(c: Context<{ Bindings: Env }>): Promise<Response> {
	const input = await c.req.json<RedeemInput>().catch(() => {
		throw new HubError("bad_request", 400);
	});
	const result = await redeemPairToken(c.env, input, c.req.header("cf-connecting-ip") ?? "unknown");
	return c.json(result, 200, { "Cache-Control": "no-store" });
}
