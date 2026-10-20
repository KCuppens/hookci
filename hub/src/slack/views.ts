// Slack views (the App Home tab and modals) and the confirm dialogs ZeroCI shows.

import { S } from "../strings";
import { type SlackConfirm, context, section } from "./blocks";

export interface SlackView {
	type: "home" | "modal";
	/** Names the modal's submission, which comes back to /slack/interactive as a view_submission with this id. */
	callback_id?: string;
	/** Slack hands this string back unchanged with the submission. */
	private_metadata?: string;
	title?: { type: "plain_text"; text: string };
	submit?: { type: "plain_text"; text: string };
	close?: { type: "plain_text"; text: string };
	blocks: unknown[];
}

/** The modal Add agent opens: the install and connect commands with the one-time token. */
export function pairTokenModal(token: string, installUrl: string, expiresAt: number): SlackView {
	const seconds = Math.floor(expiresAt / 1000);
	const iso = new Date(expiresAt).toISOString();
	return {
		type: "modal",
		title: { type: "plain_text", text: S.home.pairTokenTitle },
		close: { type: "plain_text", text: S.home.close },
		blocks: [
			section(S.home.pairTokenRun),
			section(`\`\`\`curl -fsSL ${installUrl} | sh\nsudo zeroci connect ${token}\`\`\``),
			context(S.home.pairTokenExpires(`<!date^${seconds}^{date_short_pretty} at {time}|${iso}>`)),
		],
	};
}

export function confirmRevoke(hostname: string): SlackConfirm {
	return {
		title: { type: "plain_text", text: S.home.revokeConfirmTitle },
		text: { type: "plain_text", text: S.home.revokeConfirm(hostname) },
		confirm: { type: "plain_text", text: S.home.revokeConfirmButton },
		deny: { type: "plain_text", text: S.home.cancel },
		style: "danger",
	};
}
