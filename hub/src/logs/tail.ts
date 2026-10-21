import { getRunOwner } from "../db/runs";
import type { Env } from "../env";
import { logKey } from "./keys";

/**
 * The last n lines of a job's stored log, decoded while streaming so only n
 * lines are held; null when the run or the log object does not exist.
 */
export async function getLogTail(env: Env, runId: string, job: string, n: number): Promise<string[] | null> {
	const owner = await getRunOwner(env.DB, runId);
	if (!owner) return null;
	const object = await env.LOGS.get(logKey(owner.installation_id, runId, job));
	if (!object) return null;

	const ring: string[] = [];
	let next = 0;
	const keep = (line: string): void => {
		if (n <= 0) return;
		if (ring.length < n) ring.push(line);
		else ring[next] = line;
		next = (next + 1) % n;
	};
	let partial = "";
	const text = object.body.pipeThrough(new DecompressionStream("gzip")).pipeThrough(new TextDecoderStream());
	for await (const chunk of text) {
		const lines = (partial + chunk).split("\n");
		partial = lines.pop() ?? "";
		for (const line of lines) keep(line);
	}
	if (partial !== "") keep(partial);
	return ring.length < n ? ring : [...ring.slice(next), ...ring.slice(0, next)];
}
