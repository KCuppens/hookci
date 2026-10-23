import { getRunOwner } from "../db/runs";
import type { Env } from "../env";
import { logKey } from "./keys";
import { splitStamp } from "./stamp";

/** A longer line keeps only its last part: a tail is read on a screen. */
const MAX_LINE_CHARS = 64 * 1024;

/** What a terminal shows of a line: the text after its last carriage return, since progress bars redraw with \r. */
function shown(line: string): string {
	const end = line.endsWith("\r") ? line.length - 1 : line.length;
	return line.slice(line.lastIndexOf("\r", end - 1) + 1, end).slice(-MAX_LINE_CHARS);
}

/**
 * The last n lines of a job's stored log without their agent timestamp prefix, decoded while streaming so only n
 * lines of at most MAX_LINE_CHARS are held; null when the run or the log object does not exist.
 */
export async function getLogTail(env: Env, runId: string, job: string, n: number): Promise<string[] | null> {
	const owner = await getRunOwner(env.DB, runId);
	if (!owner) return null;
	const object = await env.LOGS.get(logKey(owner.installation_id, runId, job));
	if (!object) return null;

	const ring: string[] = [];
	let next = 0;
	const keep = (raw: string): void => {
		if (n <= 0) return;
		const line = splitStamp(raw).rest;
		if (ring.length < n) ring.push(line);
		else ring[next] = line;
		next = (next + 1) % n;
	};
	let partial = "";
	const text = object.body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream());
	for await (const chunk of text) {
		const lines = (partial + chunk).split("\n");
		partial = lines.pop() ?? "";
		for (const line of lines) keep(shown(line));
		// Text before a carriage return is redrawn over; a trailing \r may still start a \r\n.
		partial = partial.slice(partial.lastIndexOf("\r", partial.length - 2) + 1).slice(-MAX_LINE_CHARS);
	}
	if (partial !== "") keep(shown(partial));
	return ring.length < n ? ring : [...ring.slice(next), ...ring.slice(0, next)];
}
