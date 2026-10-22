// The timestamp the agent puts in front of every line of a job log (agent/internal/logpipe, TimestampLayout): the UTC time it
// received the line as ISO 8601 with milliseconds, a literal Z and one space, then the output as the job wrote it:
//
//   2026-05-05T14:32:01.123Z npm ci
//
// The hub stores logs as they arrive and reads the prefix back wherever it shows lines. Logs from an agent that does not stamp have
// none and are shown as they are.

/** Anchored at the line start and exact (24 characters plus the space), so a date inside a line is never taken for a prefix. */
const STAMP = /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z) /;

/**
 * Splits the timestamp prefix off one raw log line. A line that does not start with a real instant stays whole with ts null.
 * Accepted risk: a job line that itself starts with a timestamp in exactly this format, in a log the agent did not stamp, is read
 * as a prefix.
 */
export function splitStamp(line: string): { ts: string | null; rest: string } {
	const ts = STAMP.exec(line)?.[1];
	if (ts === undefined) return { ts: null, rest: line };
	const ms = Date.parse(ts);
	if (Number.isNaN(ms) || new Date(ms).toISOString() !== ts) return { ts: null, rest: line };
	return { ts, rest: line.slice(ts.length + 1) };
}
