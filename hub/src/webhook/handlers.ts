// GitHub webhook dispatch: one handler per X-GitHub-Event the hub acts on.
// Events without a handler are recorded and otherwise ignored.

import type { Env } from "../env";
import { normalize } from "../github/normalize";
import { routeTrigger } from "./route";

export type WebhookEvent =
	| "pull_request"
	| "push"
	| "installation"
	| "installation_repositories"
	| "github_app_authorization"
	| "check_run"
	| "check_suite";

/** What a handler did with a delivery: handled it, or deliberately dropped it with a note for the deliveries row. */
export type HandlerResult = { status: "processed" } | { status: "dropped"; note: string };

export type WebhookHandler = (env: Env, payload: unknown) => Promise<HandlerResult>;

async function onTriggerEvent(env: Env, event: "pull_request" | "push", payload: unknown): Promise<HandlerResult> {
	const trig = normalize(event, payload);
	if (!trig) return { status: "processed" };
	const outcome = await routeTrigger(env, trig);
	if (outcome.kind === "suspended" || outcome.kind === "unknown_installation") return { status: "dropped", note: outcome.kind };
	return { status: "processed" };
}

const handlers: Record<WebhookEvent, WebhookHandler | null> = {
	pull_request: (env, payload) => onTriggerEvent(env, "pull_request", payload),
	push: (env, payload) => onTriggerEvent(env, "push", payload),
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
