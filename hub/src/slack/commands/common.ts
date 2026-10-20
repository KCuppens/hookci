// Small pieces every /zeroci command module uses.

import type { SlackReply } from "../registry";

/** The words after the subcommand. */
export function commandArgs(text: string): string[] {
	return text.trim().split(/\s+/).slice(1);
}

export function ephemeral(text: string, blocks?: unknown[]): SlackReply {
	return blocks ? { response_type: "ephemeral", text, blocks } : { response_type: "ephemeral", text };
}
