import { pingD1, recordStatusChecks, STATUS_COMPONENTS, type StatusCheck, type StatusComponent } from "../db/status";
import type { Env } from "../env";
import { reportError } from "../observability";

/** Resolves when the component answers, rejects when it does not. */
export type Probe = () => Promise<unknown>;
export type Probes = Record<StatusComponent, Probe>;

/** A probe that has not answered by then counts as failed. */
const PROBE_TIMEOUT_MS = 10_000;
/** A key no upload ever uses: R2 answers a head of it with null, which proves the bucket is reachable. */
const LOG_PROBE_KEY = "status-probe/absent";
/**
 * The one Durable Object id the agent probe talks to. Pairing never hands it out (agent ids are ULIDs),
 * so it belongs to no tenant. Its first request runs the AgentDO constructor, which creates the DO's own
 * empty schema; after that a GET /status is a read of that empty state and writes nothing.
 */
const AGENT_PROBE_NAME = "status-probe";

/** The real probes: D1 answers a trivial query, R2 answers a head, the agent DO namespace answers a status read. */
export function realProbes(env: Env): Probes {
	return {
		api: () => pingD1(env.DB),
		logs: () => env.LOGS.head(LOG_PROBE_KEY),
		agents: async () => {
			const res = await env.AGENT_DO.get(env.AGENT_DO.idFromName(AGENT_PROBE_NAME)).fetch("https://do/status");
			await res.arrayBuffer();
			if (!res.ok) throw new Error(`AgentDO /status answered ${res.status}`);
		},
	};
}

async function timed(component: StatusComponent, probe: Probe): Promise<StatusCheck> {
	const started = Date.now();
	let timer: number | null = null;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${component} probe timed out after ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS);
	});
	try {
		await Promise.race([probe(), deadline]);
		return { component, ok: true, latencyMs: Date.now() - started };
	} catch (err) {
		reportError(err, { task: "status_check", component });
		return { component, ok: false, latencyMs: Date.now() - started };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Probes every component once, concurrently, and records each result under the day of now. A failing
 * probe is data, not an error: it is logged and counted as a failed check. Tests inject probes.
 */
export async function runStatusChecks(env: Env, now: number, probes: Probes = realProbes(env)): Promise<StatusCheck[]> {
	const checks = await Promise.all(STATUS_COMPONENTS.map((component) => timed(component, probes[component])));
	await recordStatusChecks(env.DB, checks, now);
	return checks;
}
