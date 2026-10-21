// PUT /v1/logs/:runId/:job: an agent uploads one job's gzipped log to R2.
// Users read it through the signed links of routes/log-viewer.ts.

import type { Context } from "hono";
import { getRunOwner, setJobLog } from "../db/runs";
import { tenantDb } from "../db/tenant";
import type { Env } from "../env";
import { HubError } from "../errors";
import { logKey } from "../logs/keys";
import { logEvent } from "../observability";
import { quotaLimit } from "../quotas";
import { authenticateAgent } from "./agent-auth";

type LogContext<Path extends string> = Context<{ Bindings: Env }, Path>;

const TEXT = "text/plain; charset=utf-8";

/** The request body, refused with 413 log_too_large as soon as it passes limit bytes. */
async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (body) {
		for await (const chunk of body) {
			size += chunk.byteLength;
			if (size > limit) throw new HubError("log_too_large", 413);
			chunks.push(chunk);
		}
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export async function uploadLog(c: LogContext<"/v1/logs/:runId/:job">): Promise<Response> {
	const env = c.env;
	const agent = await authenticateAgent(env, c.req.header("authorization"));

	const runId = c.req.param("runId");
	const job = c.req.param("job");
	const key = logKey(agent.installation_id, runId, job);
	const owner = await getRunOwner(env.DB, runId);
	if (!owner || owner.installation_id !== agent.installation_id || owner.agent_id !== agent.agent_id) {
		logEvent("tenant_denied", { installation_id: agent.installation_id, agent_id: agent.agent_id, run_id: runId, job, reason: "run_not_owned" });
		throw new HubError("forbidden", 403, `agent ${agent.agent_id} does not own run ${runId}`);
	}

	if (c.req.header("content-encoding")?.toLowerCase() !== "gzip") throw new HubError("log_not_gzip", 415);
	const declared = c.req.header("x-hookci-log-bytes") ?? "";
	if (!/^[0-9]{1,15}$/.test(declared)) throw new HubError("bad_log_bytes", 400);
	const bytes = Number(declared);
	const truncated = c.req.header("x-hookci-log-truncated");
	if (truncated !== "0" && truncated !== "1") throw new HubError("bad_log_truncated", 400);
	const length = Number(c.req.header("content-length") ?? 0);
	const limit = quotaLimit(env, "logBytes");
	if (bytes > limit || length > limit) throw new HubError("log_too_large", 413);

	const body = await readCapped(c.req.raw.body, limit);
	await env.LOGS.put(key, body, { httpMetadata: { contentEncoding: "gzip", contentType: TEXT } });
	await setJobLog(tenantDb(env.DB, agent.installation_id), runId, job, { key, bytes, truncated: truncated === "1" });
	logEvent("log_uploaded", { installation_id: agent.installation_id, run_id: runId, job, bytes, gzip_bytes: body.byteLength });
	return c.body(null, 204);
}
