// PUT /v1/logs/:runId/:job: an agent uploads one job's gzipped log to R2.
// GET /logs/:runId/:job?exp=&sig=: the signed link a Slack user opens.

import type { Context } from "hono";
import { AGENT_CREDENTIAL_PREFIX, agentCredentialHash, getAgentByCredentialHash } from "../db/agents";
import { getRunOwner, setJobLog } from "../db/runs";
import { tenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { HubError } from "../errors";
import { logKey } from "../logs/keys";
import { logSigStatus } from "../logs/sign";
import { logEvent } from "../observability";
import { QUOTAS } from "../quotas";

type LogContext<Path extends string> = Context<{ Bindings: Env }, Path>;

const TEXT = "text/plain; charset=utf-8";

/** The request body, refused with 413 log_too_large as soon as it passes QUOTAS.logBytes. */
async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (body) {
		for await (const chunk of body) {
			size += chunk.byteLength;
			if (size > QUOTAS.logBytes) throw new HubError("log_too_large", 413);
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
	const credential = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
	if (!credential?.startsWith(AGENT_CREDENTIAL_PREFIX)) throw new HubError("auth_failed", 401);
	const agent = await getAgentByCredentialHash(env.DB, await agentCredentialHash(credential));
	if (!agent) throw new HubError("auth_failed", 401);
	if (agent.revoked_at !== null) throw new HubError("revoked", 401);

	const runId = c.req.param("runId");
	const job = c.req.param("job");
	const key = logKey(agent.installation_id, runId, job);
	const owner = await getRunOwner(env.DB, runId);
	if (!owner || owner.installation_id !== agent.installation_id || owner.agent_id !== agent.agent_id) {
		throw new HubError("forbidden", 403, `agent ${agent.agent_id} does not own run ${runId}`);
	}

	if (c.req.header("content-encoding")?.toLowerCase() !== "gzip") throw new HubError("log_not_gzip", 415);
	const declared = c.req.header("x-zeroci-log-bytes") ?? "";
	if (!/^[0-9]{1,15}$/.test(declared)) throw new HubError("bad_log_bytes", 400);
	const bytes = Number(declared);
	const truncated = c.req.header("x-zeroci-log-truncated");
	if (truncated !== "0" && truncated !== "1") throw new HubError("bad_log_truncated", 400);
	const length = Number(c.req.header("content-length") ?? 0);
	if (bytes > QUOTAS.logBytes || length > QUOTAS.logBytes) throw new HubError("log_too_large", 413);

	const body = await readCapped(c.req.raw.body);
	await env.LOGS.put(key, body, { httpMetadata: { contentEncoding: "gzip", contentType: TEXT } });
	await setJobLog(tenantDb(env.DB, agent.installation_id), runId, job, { key, bytes, truncated: truncated === "1" });
	logEvent("log_uploaded", { installation_id: agent.installation_id, run_id: runId, job, bytes, gzip_bytes: body.byteLength });
	return c.body(null, 204);
}

export async function viewLog(c: LogContext<"/logs/:runId/:job">): Promise<Response> {
	const env = c.env;
	const runId = c.req.param("runId");
	const job = c.req.param("job");
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	const status = await logSigStatus(env, runId, job, Number(c.req.query("exp")), c.req.query("sig") ?? "", now);
	if (status === "invalid") throw new HubError("log_sig_invalid", 403);
	if (status === "expired") throw new HubError("log_expired", 410);

	const owner = await getRunOwner(env.DB, runId);
	const object = owner && (await env.LOGS.get(logKey(owner.installation_id, runId, job)));
	if (!object) throw new HubError("log_not_found", 404);
	return new Response(object.body, {
		headers: {
			"Content-Type": TEXT,
			"Content-Encoding": "gzip",
			"Cache-Control": "private, no-store",
			"X-Robots-Tag": "noindex",
		},
		encodeBody: "manual",
	});
}
