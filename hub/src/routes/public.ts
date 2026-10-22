// The public legal, support and status pages GitHub and Slack link to from the app listings.

import { Hono } from "hono";
import { INTER_WOFF2_BASE64 } from "../assets/inter";
import type { Env } from "../env";
import { privacyPage, supportPage, termsPage } from "../pages/legal";
import { statusRoute } from "./status";

let interBytes: Uint8Array | undefined;

/** The self-hosted Inter font: immutable, so a year of public caching. */
function interFont(): Response {
	interBytes ??= Uint8Array.from(atob(INTER_WOFF2_BASE64), (ch) => ch.charCodeAt(0));
	return new Response(interBytes, {
		headers: {
			"Content-Type": "font/woff2",
			"Cache-Control": "public, max-age=31536000, immutable",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

export const publicRoutes = new Hono<{ Bindings: Env }>()
	.get("/privacy", () => privacyPage())
	.get("/terms", () => termsPage())
	.get("/support", () => supportPage())
	.get("/status", statusRoute)
	.get("/assets/inter.woff2", () => interFont());
