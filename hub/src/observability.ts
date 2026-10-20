// Structured logs: one JSON object per line, picked up by Workers Logs.
// Every string goes through redact() so tokens never reach the logs.

import { redact } from "./crypto";
import { HubError } from "./errors";

type Fields = Record<string, string | number | boolean>;

function redactFields(fields: Fields): Fields {
	const out: Fields = {};
	for (const [k, v] of Object.entries(fields)) out[k] = typeof v === "string" ? redact(v) : v;
	return out;
}

/** Logs an unexpected error. ctx tags it, for example with installation_id. */
export function reportError(err: unknown, ctx: Record<string, string | number>): void {
	const error =
		err instanceof Error
			? {
					name: err.name,
					...(err instanceof HubError ? { code: err.code } : {}),
					message: redact(err.message),
					...(err.stack ? { stack: redact(err.stack) } : {}),
				}
			: { name: "NonError", message: redact(String(err)) };
	console.error(JSON.stringify({ ...redactFields(ctx), level: "error", error }));
}

export function logEvent(name: string, fields: Fields = {}): void {
	console.log(JSON.stringify({ ...redactFields(fields), level: "info", event: name }));
}
