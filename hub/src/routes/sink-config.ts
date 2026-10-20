// The agent API over the sink config service, for `zeroci sink add|ls|rm|test`.
// Every route takes the agent's `zc_agent_` credential and acts on the
// agent's installation only. Bodies and answers use snake_case fields.

import type { Context } from "hono";
import { type TenantDb, tenantDb } from "../db/tenant";
import type { Env } from "../env";
import { HubError } from "../errors";
import {
	addSinkConfig,
	listSinkConfigsForRepo,
	removeSinkConfig,
	type SinkActor,
	SinkConfigError,
	type SinkConfigInput,
	SinkQuotaError,
	sendTestDelivery,
} from "../sinks/config-service";
import { S } from "../strings";
import { authenticateAgent } from "./agent-auth";

type SinkContext = Context<{ Bindings: Env }>;

const FIELDS = {
	telegram: { required: ["kind", "repo", "bot_token", "chat_id"], optional: ["label"] },
	webhook: { required: ["kind", "repo", "url"], optional: ["label"] },
	linear: { required: ["kind", "repo", "api_key", "team_key"], optional: ["assignee_email", "label"] },
} as const;

function invalid(field: string, reason: string): SinkConfigError {
	return new SinkConfigError("invalid", S.sinks.invalidField(field, reason));
}

/** The add body as a SinkConfigInput; throws invalid naming the first field that is wrong. */
function parseAddBody(body: unknown): SinkConfigInput {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("body", "must be a JSON object");
	const b = body as Record<string, unknown>;
	if (b.kind !== "telegram" && b.kind !== "webhook" && b.kind !== "linear") throw invalid("kind", "must be telegram, webhook or linear");
	const fields = FIELDS[b.kind];
	const allowed: readonly string[] = [...fields.required, ...fields.optional];
	const unknown = Object.keys(b).find((key) => !allowed.includes(key));
	if (unknown !== undefined) throw invalid(unknown, `not a ${b.kind} field`);
	for (const key of allowed) {
		if (Object.hasOwn(b, key) ? typeof b[key] !== "string" : (fields.required as readonly string[]).includes(key)) throw invalid(key, "required string");
	}
	const label = typeof b.label === "string" ? { label: b.label } : {};
	const repo = b.repo as string;
	switch (b.kind) {
		case "telegram":
			return { kind: "telegram", repo, botToken: b.bot_token as string, chatId: b.chat_id as string, ...label };
		case "webhook":
			return { kind: "webhook", repo, url: b.url as string, ...label };
		case "linear": {
			const assignee = typeof b.assignee_email === "string" ? { assigneeEmail: b.assignee_email } : {};
			return { kind: "linear", repo, apiKey: b.api_key as string, teamKey: b.team_key as string, ...assignee, ...label };
		}
	}
}

/** Authenticates the agent, then runs handler on its installation, answering the service's refusals. */
async function asAgent(c: SinkContext, handler: (t: TenantDb, actor: SinkActor) => Promise<Response>): Promise<Response> {
	const agent = await authenticateAgent(c.env, c.req.header("authorization"));
	try {
		return await handler(tenantDb(c.env.DB, agent.installation_id), { type: "agent", id: agent.agent_id });
	} catch (err) {
		if (err instanceof SinkQuotaError) return c.json({ error: err.code }, 429, { "Retry-After": String(err.retryAfterSeconds) });
		if (err instanceof SinkConfigError) return c.json({ error: err.code, message: err.message }, err.code === "repo_not_bound" ? 403 : 400);
		throw err;
	}
}

/** GET /v1/agent/sinks?repo=owner/name: 200 `{sinks}`, disabled ones included. */
export async function listSinks(c: SinkContext): Promise<Response> {
	return asAgent(c, async (t) => c.json({ sinks: await listSinkConfigsForRepo(t, c.req.query("repo") ?? "") }));
}

/** POST /v1/agent/sinks: 201 `{sink, generated_secret?}`; the webhook secret is in this answer only. */
export async function addSink(c: SinkContext): Promise<Response> {
	return asAgent(c, async (t, actor) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			throw invalid("body", "must be a JSON object");
		}
		const { sink, generatedSecret } = await addSinkConfig(c.env, t, actor, parseAddBody(body));
		return c.json(generatedSecret === undefined ? { sink } : { sink, generated_secret: generatedSecret }, 201);
	});
}

/** DELETE /v1/agent/sinks/:id: 204, or 404 when the installation has no such sink. */
export async function removeSink(c: SinkContext): Promise<Response> {
	return asAgent(c, async (t, actor) => {
		if (!(await removeSinkConfig(c.env, t, actor, c.req.param("id") ?? ""))) throw new HubError("not_found", 404);
		return c.body(null, 204);
	});
}

/** POST /v1/agent/sinks/:id/test: 200 `{result, detail?}` with how the provider took a test delivery. */
export async function testSink(c: SinkContext): Promise<Response> {
	return asAgent(c, async (t, actor) => {
		const result = await sendTestDelivery(c.env, t, actor, c.req.param("id") ?? "");
		const detail = result.kind === "ok" ? undefined : result.kind === "fail" && result.disable ? result.disable : result.httpStatus !== undefined ? `http_${result.httpStatus}` : undefined;
		return c.json(detail === undefined ? { result: result.kind } : { result: result.kind, detail });
	});
}
