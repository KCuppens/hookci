import { PROTOCOL_MAX, PROTOCOL_MIN } from "./do/agent-protocol";
import type { Env } from "./env";

/** The agent protocol versions this hub speaks, oldest first: [N-1, N], never below 1. */
export const PROTOCOL_VERSIONS: [number, number] = [PROTOCOL_MIN, PROTOCOL_MAX];

/** Var naming the newest released agent version; agents older than it log an upgrade hint. */
export const LATEST_AGENT_VERSION = "LATEST_AGENT_VERSION";
/** Var naming the oldest agent version the hub serves; older agents stop with agent_too_old. */
export const MIN_AGENT_VERSION = "MIN_AGENT_VERSION";

export interface AgentVersions {
	latest_agent_version?: string;
	min_agent_version?: string;
}

/** The welcome's agent version fields; an empty var leaves its field out. */
export function agentVersions(env: Pick<Env, typeof LATEST_AGENT_VERSION | typeof MIN_AGENT_VERSION>): AgentVersions {
	const out: AgentVersions = {};
	if (env[LATEST_AGENT_VERSION]) out.latest_agent_version = env[LATEST_AGENT_VERSION];
	if (env[MIN_AGENT_VERSION]) out.min_agent_version = env[MIN_AGENT_VERSION];
	return out;
}
