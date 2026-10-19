// Every user-facing message, keyed by id. Messages that need values are
// functions taking those values.
export const S = {
	noChecks: "No checks detected: add `.zeroci.yml`",
	slowDown: "Slow down: too many /zeroci commands in this workspace, try again in a minute.",
	updating: "ZeroCI is updating, retry in a minute",
	agentProtocolUnsupported: (version: string, min: number, max: number) =>
		`Agent protocol ${version} is not supported; this hub accepts ${min} to ${max}.`,
	agentUpgradeHint: "run: sudo zeroci upgrade",
	agentHelloFirst: "The first frame must be hello.",
	agentHelloRepeated: "hello is only sent once per connection.",
	agentFrameTooLarge: "Frame is larger than 1 MiB.",
	agentFrameNotText: "Frames must be text.",
	agentFrameNotFromAgent: (type: string) => `${type} frames are sent by the hub, not the agent.`,
	agentFrameLacksSeq: (type: string) => `${type} frame lacks a positive integer seq.`,
	agentRateLimited: "More than 200 frames in one second.",
	agentRevoked: "This agent was revoked; pair it again with a new pair token.",
	runNotBound: "run not bound to this agent",
} as const;
