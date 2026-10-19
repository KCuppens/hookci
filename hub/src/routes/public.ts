// The public legal and support pages GitHub and Slack link to from the app listings.

import { Hono } from "hono";
import type { Env } from "../env";
import { privacyPage, supportPage, termsPage } from "../pages/legal";

export const publicRoutes = new Hono<{ Bindings: Env }>()
	.get("/privacy", () => privacyPage())
	.get("/terms", () => termsPage())
	.get("/support", () => supportPage());
