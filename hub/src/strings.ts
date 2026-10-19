// Every user-facing message, keyed by id. Messages that need values are
// functions taking those values.
export const S = {
	noChecks: "No checks detected: add `.zeroci.yml`",
	slowDown: "Slow down: too many /zeroci commands in this workspace, try again in a minute.",
	updating: "ZeroCI is updating, retry in a minute",
} as const;
