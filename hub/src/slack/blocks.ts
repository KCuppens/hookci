// Block Kit builders for the few block shapes ZeroCI sends.

export interface SectionBlock {
	type: "section";
	text: { type: "mrkdwn"; text: string };
}

export interface ContextBlock {
	type: "context";
	elements: [{ type: "mrkdwn"; text: string }];
}

export interface ButtonElement {
	type: "button";
	action_id: string;
	text: { type: "plain_text"; text: string; emoji: true };
	value: string;
	style?: "primary" | "danger";
}

/** A button that opens url in the browser; Slack needs no handler for it. */
export interface LinkButtonElement {
	type: "button";
	text: { type: "plain_text"; text: string; emoji: true };
	url: string;
	style?: "primary" | "danger";
}

export interface ActionsBlock {
	type: "actions";
	elements: (ButtonElement | LinkButtonElement)[];
}

export function section(text: string): SectionBlock {
	return { type: "section", text: { type: "mrkdwn", text } };
}

export function context(text: string): ContextBlock {
	return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

export function button(actionId: string, text: string, value: string, style?: "primary" | "danger"): ButtonElement {
	return { type: "button", action_id: actionId, text: { type: "plain_text", text, emoji: true }, value, ...(style ? { style } : {}) };
}

export function linkButton(text: string, url: string, style?: "primary" | "danger"): LinkButtonElement {
	return { type: "button", text: { type: "plain_text", text, emoji: true }, url, ...(style ? { style } : {}) };
}

export function actions(...buttons: (ButtonElement | LinkButtonElement)[]): ActionsBlock {
	return { type: "actions", elements: buttons };
}
