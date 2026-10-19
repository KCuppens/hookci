// GitHub webhook dispatch: one handler per X-GitHub-Event the hub acts on.
// Events without a handler are recorded and otherwise ignored.

import type { Env } from "../env";
import { normalize } from "../github/normalize";
import type { WaitUntil } from "../sinks";
import { routeTrigger } from "./route";

/** Every X-GitHub-Event the dispatch table has an entry for; the GitHub App manifest subscribes to exactly these. */
export const HANDLED_GITHUB_EVENTS = [
	"pull_request",
	"push",
	"installation",
	"installation_repositories",
	"github_app_authorization",
	"check_run",
	"check_suite",
] as const;

export type WebhookEvent = (typeof HANDLED_GITHUB_EVENTS)[number];

/** What a handler did with a delivery: handled it, or deliberately dropped it with a note for the deliveries row. */
export type HandlerResult = { status: "processed" } | { status: "dropped"; note: string };

export type WebhookHandler = (env: Env, payload: unknown, ctx: WaitUntil) => Promise<HandlerResult>;

async function onTriggerEvent(env: Env, event: "pull_request" | "push", payload: unknown, ctx: WaitUntil): Promise<HandlerResult> {
	const trig = normalize(event, payload);
	if (!trig) return { status: "processed" };
	const outcome = await routeTrigger(env, trig, ctx);
	if (outcome.kind === "deleted" || outcome.kind === "unknown_installation") return { status: "dropped", note: outcome.kind };
	return { status: "processed" };
}

const handlers: Record<WebhookEvent, WebhookHandler | null> = {
	pull_request: (env, payload, ctx) => onTriggerEvent(env, "pull_request", payload, ctx),
	push: (env, payload, ctx) => onTriggerEvent(env, "push", payload, ctx),
	installation: null,
	installation_repositories: null,
	github_app_authorization: null,
	check_run: null,
	check_suite: null,
};

/** Installs fn as the handler for event, replacing the current one. */
export function registerHandler(event: WebhookEvent, fn: WebhookHandler): void {
	handlers[event] = fn;
}

function isWebhookEvent(event: string): event is WebhookEvent {
	return Object.hasOwn(handlers, event);
}

/** The handler for an X-GitHub-Event value, or null when the hub ignores the event. */
export function handlerFor(event: string): WebhookHandler | null {
	return isWebhookEvent(event) ? handlers[event] : null;
}
