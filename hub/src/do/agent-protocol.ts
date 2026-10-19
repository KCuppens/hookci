// Connection rules the AgentDO enforces on the agent WebSocket: protocol
// negotiation, close codes and frame limits.

import type { ProtocolErrorFrame } from "../protocol";
import { S } from "../strings";

/** Newest protocol version this hub speaks. */
export const PROTOCOL_MAX = 1;
/** Oldest protocol version this hub accepts: one behind PROTOCOL_MAX, never below 1. */
export const PROTOCOL_MIN = Math.max(1, PROTOCOL_MAX - 1);

/**
 * Close codes the hub sends. 4000 another connection took over; 4400 the
 * first frame was not an acceptable hello, or too many bad frames; 4401 the
 * agent was revoked; 4408 no ping for OFFLINE_AFTER_MS; 4429 too many frames.
 */
export const CLOSE = {
	replaced: 4000,
	badFrame: 4400,
	revoked: 4401,
	pingTimeout: 4408,
	rateLimited: 4429,
} as const;

/** Largest accepted frame, in bytes. */
export const MAX_FRAME_BYTES = 1_048_576;
/** Frames per second one socket may send before it is closed with CLOSE.rateLimited. */
export const MAX_FRAMES_PER_SECOND = 200;
/** Bad frames per minute one socket may send before it is closed with CLOSE.badFrame. */
export const MAX_BAD_FRAMES_PER_MINUTE = 20;
/** How often the alarm checks the socket while one is attached or alarm tasks are pending. */
export const ALARM_INTERVAL_MS = 30_000;
/** A socket silent for longer than this is closed and the agent marked offline. */
export const OFFLINE_AFTER_MS = 60_000;
/** Minimum gap between two last_seen_at writes to D1 for the same agent. */
export const SEEN_WRITE_INTERVAL_MS = 5 * 60_000;

/** Ping text the agent sends; the runtime answers PONG without waking the DO. */
export const PING = "ping";
export const PONG = "pong";

export type Negotiation = { ok: true; protocol: number } | { ok: false; error: ProtocolErrorFrame };

/**
 * Picks the protocol for a hello: the agent's version when it lies in
 * [min, max], otherwise a protocol_unsupported error frame with the upgrade hint.
 */
export function negotiate(hello: { protocol_version: unknown }, min = PROTOCOL_MIN, max = PROTOCOL_MAX): Negotiation {
	const version = hello.protocol_version;
	if (typeof version === "number" && Number.isInteger(version) && version >= min && version <= max) {
		return { ok: true, protocol: version };
	}
	return {
		ok: false,
		error: {
			v: 1,
			type: "error",
			code: "protocol_unsupported",
			message: S.agentProtocolUnsupported(String(version), min, max),
			upgrade_hint: S.agentUpgradeHint,
		},
	};
}
