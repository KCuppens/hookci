// The Add sink modal `/zeroci sink add <owner/repo>` opens, and the parse of
// its submission into the config service's input. Every input is optional at
// Slack level, since which ones a sink needs depends on its kind: the parse
// names the missing ones, and the config service checks what was given.

import type { SinkKind } from "../db/sinks";
import { LINEAR_TEAM_KEY, type SinkConfigInput } from "../sinks/config-service";
import { S } from "../strings";
import { section } from "./blocks";
import type { SlackView } from "./views";

export const SINK_ADD_CALLBACK_ID = "zeroci_sink_add";

/** Each field's block_id and action_id, so the errors of a submission are keyed by field. */
export type SinkField = "kind" | "bot_token" | "chat_id" | "webhook_url" | "linear_api_key" | "linear_team" | "linear_assignee_email" | "label";

const KINDS: readonly SinkKind[] = ["telegram", "webhook", "linear"];

interface SlackInputState {
	value?: string | null;
	selected_option?: { value?: string } | null;
}

/** The parts of a view_submission's view the parse reads. */
export interface SlackViewSubmission {
	private_metadata?: string;
	state?: { values?: Record<string, Record<string, SlackInputState> | undefined> };
}

export type SinkAddSubmission = { repo: string; channel: string; input: SinkConfigInput } | { errors: Record<string, string> };

const plain = (text: string) => ({ type: "plain_text" as const, text });

function textInput(field: SinkField, label: string, hint: string, maxLength: number) {
	return {
		type: "input",
		block_id: field,
		optional: true,
		label: plain(label),
		hint: plain(hint),
		element: { type: "plain_text_input", action_id: field, max_length: maxLength },
	};
}

/** The modal for adding a sink to repo; channel is where the result is posted, ephemeral to the submitter. */
export function buildSinkAddModal(repo: string, channel: string): SlackView {
	return {
		type: "modal",
		callback_id: SINK_ADD_CALLBACK_ID,
		private_metadata: JSON.stringify({ repo, channel }),
		title: plain(S.slack.sinkModal.title),
		submit: plain(S.slack.sinkModal.submit),
		close: plain(S.slack.sinkModal.close),
		blocks: [
			section(S.slack.sinkModal.intro(repo)),
			{
				type: "input",
				block_id: "kind",
				optional: true,
				label: plain(S.slack.sinkModal.kind),
				element: { type: "radio_buttons", action_id: "kind", options: KINDS.map((kind) => ({ text: plain(S.slack.sinkKind[kind]), value: kind })) },
			},
			textInput("bot_token", S.slack.sinkModal.botToken, S.slack.sinkModal.botTokenHint, 200),
			textInput("chat_id", S.slack.sinkModal.chatId, S.slack.sinkModal.chatIdHint, 100),
			textInput("webhook_url", S.slack.sinkModal.webhookUrl, S.slack.sinkModal.webhookUrlHint, 2000),
			textInput("linear_api_key", S.slack.sinkModal.linearApiKey, S.slack.sinkModal.linearApiKeyHint, 200),
			textInput("linear_team", S.slack.sinkModal.linearTeam, S.slack.sinkModal.linearTeamHint, 10),
			textInput("linear_assignee_email", S.slack.sinkModal.linearAssigneeEmail, S.slack.sinkModal.linearAssigneeEmailHint, 320),
			textInput("label", S.slack.sinkModal.label, S.slack.sinkModal.labelHint, 100),
		],
	};
}

/** What the Add sink modal turns into when the ephemeral result could not be posted, so a webhook's one-time secret is still shown. */
export function buildSinkAddedModal(text: string): SlackView {
	return { type: "modal", title: plain(S.slack.sinkModal.addedTitle), close: plain(S.slack.sinkModal.done), blocks: [section(text)] };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether view has the shape of a view_submission's view: string metadata and a values map of input states. */
export function isSlackViewSubmission(view: unknown): view is SlackViewSubmission {
	if (!isObject(view)) return false;
	if (view.private_metadata !== undefined && typeof view.private_metadata !== "string") return false;
	if (view.state === undefined) return true;
	if (!isObject(view.state)) return false;
	const { values } = view.state;
	return values === undefined || (isObject(values) && Object.values(values).every((block) => isObject(block) && Object.values(block).every(isObject)));
}

function metadata(raw: string | undefined): { repo: string; channel: string } | null {
	try {
		const parsed: unknown = JSON.parse(raw ?? "");
		if (isObject(parsed) && typeof parsed.repo === "string" && typeof parsed.channel === "string") return { repo: parsed.repo, channel: parsed.channel };
	} catch {
		// Not JSON: not a form this module built.
	}
	return null;
}

/** The repo, channel and config input of a submitted Add sink modal, or the error of each field that needs fixing. */
export function parseSinkAddSubmission(view: SlackViewSubmission): SinkAddSubmission {
	const meta = metadata(view.private_metadata);
	if (meta === null) return { errors: { kind: S.slack.sinkModal.expired } };
	const values = view.state?.values ?? {};
	const state = (field: SinkField) => values[field]?.[field];
	const text = (field: SinkField) => {
		const value = state(field)?.value;
		return typeof value === "string" ? value.trim() : "";
	};
	const label = text("label");
	const named = label === "" ? {} : { label };
	const kind = state("kind")?.selected_option?.value;

	if (kind === "telegram") {
		const botToken = text("bot_token");
		const chatId = text("chat_id");
		const errors: Record<string, string> = {};
		if (botToken === "") errors.bot_token = S.slack.sinkModal.needBotToken;
		if (chatId === "") errors.chat_id = S.slack.sinkModal.needChatId;
		if (Object.keys(errors).length > 0) return { errors };
		return { ...meta, input: { kind, repo: meta.repo, botToken, chatId, ...named } };
	}
	if (kind === "webhook") {
		const url = text("webhook_url");
		if (url === "") return { errors: { webhook_url: S.slack.sinkModal.needWebhookUrl } };
		return { ...meta, input: { kind, repo: meta.repo, url, ...named } };
	}
	if (kind === "linear") {
		const apiKey = text("linear_api_key");
		const teamKey = text("linear_team");
		const assigneeEmail = text("linear_assignee_email");
		const errors: Record<string, string> = {};
		if (apiKey === "") errors.linear_api_key = S.slack.sinkModal.needLinearApiKey;
		if (teamKey === "") errors.linear_team = S.slack.sinkModal.needLinearTeam;
		else if (!LINEAR_TEAM_KEY.test(teamKey)) errors.linear_team = S.slack.sinkModal.badLinearTeam;
		if (Object.keys(errors).length > 0) return { errors };
		return { ...meta, input: { kind, repo: meta.repo, apiKey, teamKey, ...(assigneeEmail === "" ? {} : { assigneeEmail }), ...named } };
	}
	return { errors: { kind: S.slack.sinkModal.chooseKind } };
}
