// Handlers for /zeroci subcommands, interactive actions and Events API
// events. Feature modules register at import time; the Slack routes and
// SlackWorkspaceDO look them up, so new features never edit the routes.

import type { Env } from "../env";

export interface SlackCommandCtx {
	env: Env;
	teamId: string;
	userId: string;
	channelId: string;
	/** The command text as Slack sent it, subcommand included. */
	text: string;
	responseUrl: string;
	triggerId: string;
}

export interface SlackActionCtx {
	env: Env;
	teamId: string;
	userId: string;
	/** The full action id, for example `run.retry:123`; for a modal submission, the view's callback_id. */
	actionId: string;
	/** The button value or selected option; for a modal submission, the view's private_metadata. */
	value: string;
	/** Null where Slack sends none, as for App Home actions and modal submissions. */
	responseUrl: string | null;
	triggerId: string;
	view?: unknown;
	channelId?: string;
	messageTs?: string;
}

export type SlackReply = { text: string; blocks?: unknown[]; response_type?: "ephemeral" | "in_channel"; replace_original?: boolean };

/** What the routes send SlackWorkspaceDO: the context without env, which the DO supplies. */
export type SlackCommandRequest = Omit<SlackCommandCtx, "env">;
export type SlackActionRequest = Omit<SlackActionCtx, "env">;

export type CommandHandler = (ctx: SlackCommandCtx) => Promise<SlackReply>;
export type ActionHandler = (ctx: SlackActionCtx) => Promise<SlackReply | null>;
export type EventHandler = (env: Env, teamId: string, event: Record<string, unknown>) => Promise<void>;

const commands = new Map<string, CommandHandler>();
const actions = new Map<string, ActionHandler>();
const events = new Map<string, EventHandler>();

/** Serves `/zeroci <name> ...`; name "" serves a bare `/zeroci` and unknown subcommands (help). A later registration replaces an earlier one. */
export function registerCommand(name: string, fn: CommandHandler): void {
	commands.set(name.toLowerCase(), fn);
}

/** Serves action ids equal to actionIdPrefix or starting with actionIdPrefix + ":", as `run.retry:123` for `run.retry`. */
export function registerAction(actionIdPrefix: string, fn: ActionHandler): void {
	actions.set(actionIdPrefix, fn);
}

/** Serves Events API events of type, as `app_home_opened`. */
export function registerEvent(type: string, fn: EventHandler): void {
	events.set(type, fn);
}

/** The handler for the subcommand that starts text (case-insensitive), or undefined when none is registered. */
export function commandFor(text: string): CommandHandler | undefined {
	return commands.get((text.trim().split(/\s+/, 1)[0] ?? "").toLowerCase());
}

/** The handler whose prefix matches actionId, the longest one when several do. */
export function actionFor(actionId: string): ActionHandler | undefined {
	let best: { prefix: string; fn: ActionHandler } | undefined;
	for (const [prefix, fn] of actions) {
		if (actionId !== prefix && !actionId.startsWith(`${prefix}:`)) continue;
		if (!best || prefix.length > best.prefix.length) best = { prefix, fn };
	}
	return best?.fn;
}

export function eventHandlerFor(type: string): EventHandler | undefined {
	return events.get(type);
}

export function resetRegistryForTests(): void {
	commands.clear();
	actions.clear();
	events.clear();
}
