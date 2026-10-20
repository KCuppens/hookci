// POST /v1/render: an agent asks how the hub would render a deploy badge, for
// `zeroci deploy <env> --dry-run`. The agent holds no copy of the strings.

import type { Context } from "hono";
import { listBindingsForAgent } from "../db/bindings";
import { getRepoByFullName } from "../db/repos";
import { tenantDb } from "../db/tenant";
import { renderDeployBadge } from "../deploy/render";
import type { Env } from "../env";
import { HubError } from "../errors";
import { logEvent } from "../observability";
import type { RenderRequest, RenderResponse } from "../protocol";
import { authenticateAgent } from "./agent-auth";

const STATES: readonly RenderRequest["state"][] = ["queued", "running", "rolling_back", "succeeded", "failed"];
const ENV_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SHA = /^[0-9a-f]{40}$/;
const FIELDS: Record<keyof RenderRequest, true> = {
	v: true,
	kind: true,
	repo: true,
	env: true,
	sha: true,
	state: true,
	step: true,
	step_index: true,
	steps_total: true,
	duration_ms: true,
};

/** `<field>: <reason>` for the first field of body that breaks the RenderRequest schema, or null. */
function renderRequestError(body: unknown): string | null {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return "body: must be a JSON object";
	const b = body as Record<string, unknown>;
	const unknown = Object.keys(b).find((key) => !Object.hasOwn(FIELDS, key));
	if (unknown !== undefined) return `${unknown}: unknown field`;
	for (const key of ["v", "kind", "repo", "env", "sha", "state"]) {
		if (!Object.hasOwn(b, key)) return `${key}: required`;
	}
	if (b.v !== 1) return "v: must be 1";
	if (b.kind !== "deploy_badge") return "kind: must be deploy_badge";
	if (typeof b.repo !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(b.repo)) return "repo: must be owner/name";
	if (typeof b.env !== "string" || !ENV_NAME.test(b.env)) return `env: must match ${ENV_NAME.source}`;
	if (typeof b.sha !== "string" || !SHA.test(b.sha)) return "sha: must be 40 lowercase hex characters";
	if (!STATES.includes(b.state as RenderRequest["state"])) return `state: must be one of ${STATES.join(", ")}`;
	if (Object.hasOwn(b, "step") && typeof b.step !== "string") return "step: must be a string";
	for (const [key, min] of [
		["step_index", 0],
		["steps_total", 1],
		["duration_ms", 0],
	] as const) {
		if (Object.hasOwn(b, key) && !(Number.isSafeInteger(b[key]) && (b[key] as number) >= min)) {
			return `${key}: must be an integer >= ${min}`;
		}
	}
	return null;
}

export async function renderPreview(c: Context<{ Bindings: Env }>): Promise<Response> {
	const env = c.env;
	const agent = await authenticateAgent(env, c.req.header("authorization"));

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ v: 1, error: "body: must be a JSON object" }, 400);
	}
	const invalid = renderRequestError(body);
	if (invalid !== null) return c.json({ v: 1, error: invalid }, 400);
	const req = body as RenderRequest;

	const t = tenantDb(env.DB, agent.installation_id);
	const repo = await getRepoByFullName(t, req.repo);
	const bound = repo !== null && (await listBindingsForAgent(t, agent.agent_id)).some((b) => b.repo_id === repo.repo_id);
	if (!bound) {
		logEvent("tenant_denied", { installation_id: agent.installation_id, agent_id: agent.agent_id, repo: req.repo, reason: "repo_not_bound" });
		throw new HubError("forbidden", 403, `agent ${agent.agent_id} is not bound to ${req.repo}`);
	}

	const badge = renderDeployBadge({
		env: req.env,
		sha: req.sha,
		state: req.state,
		...(req.step !== undefined ? { step: req.step } : {}),
		...(req.step_index !== undefined ? { stepIndex: req.step_index } : {}),
		...(req.steps_total !== undefined ? { stepsTotal: req.steps_total } : {}),
		...(req.duration_ms !== undefined ? { durationMs: req.duration_ms } : {}),
	});
	const res: RenderResponse = { v: 1, text: badge.text, blocks: badge.blocks as RenderResponse["blocks"] };
	return c.json(res);
}
