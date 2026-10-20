// Handlers for sequenced agent frames. The AgentDO dedupes by seq and acks;
// a handler only sees each frame once.

import type { Frame } from "../protocol";
import type { AgentDO } from "./agent";

// Agent to hub frame types that travel through the agent outbox and carry seq.
const AGENT_FRAME_TYPES = {
	accepted: true,
	rejected: true,
	job_planned: true,
	event: true,
	annotations: true,
	token_request: true,
} as const satisfies Partial<Record<Frame["type"], true>>;

export type AgentFrameType = keyof typeof AGENT_FRAME_TYPES;
export type AgentFrame = Extract<Frame, { type: AgentFrameType }>;
export type FrameHandler<T extends AgentFrameType> = (dob: AgentDO, frame: Extract<Frame, { type: T }>) => Promise<void>;

export function isAgentFrame(frame: Frame): frame is AgentFrame {
	return Object.hasOwn(AGENT_FRAME_TYPES, frame.type);
}

const handlers = new Map<AgentFrameType, FrameHandler<AgentFrameType>>();

/** Sets the handler for one frame type, replacing any earlier one; returns a function that removes it. */
export function registerFrameHandler<T extends AgentFrameType>(type: T, fn: FrameHandler<T>): () => void {
	// Keyed by type, so the handler stored under T only ever receives frames of type T.
	const stored = fn as unknown as FrameHandler<AgentFrameType>;
	handlers.set(type, stored);
	return () => {
		if (handlers.get(type) === stored) handlers.delete(type);
	};
}

export function frameHandler(type: AgentFrameType): FrameHandler<AgentFrameType> | undefined {
	return handlers.get(type);
}
