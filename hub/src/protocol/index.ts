// Agent to hub WebSocket frames: the types generated from
// schema/zeroci.schema.json ($defs.protocol) into types.gen.ts, plus parsing
// and encoding. Run `make schema` after changing the schema.

import type { Frame } from "./types.gen";

export type * from "./types.gen";

/** Thrown by parseFrame. code is the error frame code to answer with. */
export class ProtocolError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ProtocolError";
		this.code = code;
	}
}

type FrameType = Frame["type"];
type FrameOf<T extends FrameType> = Extract<Frame, { type: T }>;
// Required named keys of T. Index signatures (Interrupt carries one from its
// oneOf) are dropped, since indexing by them would hide the named keys.
type RequiredKey<T> = keyof {
	[K in keyof T as string extends K ? never : {} extends Pick<T, K> ? never : K]: unknown;
} &
	string;

// Required fields per frame type other than v and type. satisfies rejects a
// key the generated type does not require; MissingKey names a required key
// left out, and AssertNever fails to compile unless it is never.
const REQUIRED = {
	hello: ["protocol_version", "agent_version"],
	trigger: ["hub_seq", "trigger_id", "repo", "sha", "ref", "event", "attempt", "trust"],
	accepted: ["trigger_id", "run_id"],
	rejected: ["trigger_id", "reason"],
	job_planned: ["run_id", "jobs"],
	event: ["agent_seq", "run_id", "state"],
	annotations: ["agent_seq", "run_id", "job", "items"],
	token_request: ["run_id", "purpose"],
	token: ["run_id", "token", "exp"],
	log_subscribe: ["run_id"],
	log: ["run_id", "job", "offset", "bytes"],
	ack: ["upto"],
	welcome: ["hub_version", "protocol_min", "protocol_max", "agent_id", "installation_id"],
	interrupt: ["reason"],
	error: ["code", "message"],
} as const satisfies { readonly [T in FrameType]: readonly RequiredKey<FrameOf<T>>[] };

type MissingKey = {
	[T in FrameType]: Exclude<RequiredKey<FrameOf<T>>, "v" | "type" | (typeof REQUIRED)[T][number]>;
}[FrameType];
type AssertNever<T extends never> = T;
type RequiredKeysComplete = AssertNever<MissingKey>;

function isFrameType(type: string): type is FrameType {
	return Object.hasOwn(REQUIRED, type);
}

function badFrame(message: string): ProtocolError {
	return new ProtocolError("bad_frame", message);
}

/**
 * Parses one WebSocket text message. Checks v, type and the type's required
 * fields, and that an interrupt carries exactly one of run_id or trigger_id.
 * Field values are not checked. Throws ProtocolError with code "bad_frame".
 */
export function parseFrame(text: string): Frame {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw badFrame("frame is not valid JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw badFrame("frame is not a JSON object");
	}
	if (!("v" in value) || value.v !== 1) {
		throw badFrame("frame v is not 1");
	}
	if (!("type" in value) || typeof value.type !== "string" || !isFrameType(value.type)) {
		throw badFrame("frame type is missing or unknown");
	}
	const type = value.type;
	for (const key of REQUIRED[type]) {
		if (!Object.hasOwn(value, key)) {
			throw badFrame(`${type} frame lacks ${key}`);
		}
	}
	if (type === "interrupt" && Object.hasOwn(value, "run_id") === Object.hasOwn(value, "trigger_id")) {
		throw badFrame("interrupt frame needs exactly one of run_id or trigger_id");
	}
	// v, type and every required key are present; that is the contract above.
	return value as Frame;
}

export function encodeFrame(f: Frame): string {
	return JSON.stringify(f);
}
