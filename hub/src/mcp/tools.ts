// The 7 tools the MCP server exposes, each scoped to one installation by the
// bearer token that authenticated the request (see ./server.ts). A tool
// never throws for a domain failure (run not found, job not found, ...): it
// returns isError: true so the MCP client sees a normal tool result instead
// of a protocol-level error.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { listAgents } from "../db/agents";
import { listRunsFiltered } from "../db/overview";
import { getRepo, getRepoByFullName, listRepos } from "../db/repos";
import { type RunListRow, getJobOfRun, getRunListRow, isRunId, listJobsOfRun, listRunsPage } from "../db/runs";
import { type TenantDb, tenantDb } from "../db/tenant";
import type { Env } from "../env";
import { logKey } from "../logs/keys";
import { readRenderable } from "../routes/log-viewer";
import { cancelRun } from "../runs/cancel";
import { retryRun } from "../runs/retry";
import { commandGitHub, type ResolvedRepo } from "../slack/resolve";

function textResult(payload: unknown, isError = false): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(payload) }], isError };
}

/** The run of run_id in this installation, or null when it is not a run id or there is no such run. */
async function resolveRun(t: TenantDb, runId: string): Promise<RunListRow | null> {
	if (!isRunId(runId)) return null;
	return getRunListRow(t, runId);
}

function formatRun(run: RunListRow) {
	return {
		run_id: run.run_id,
		run_rowid: run.run_rowid,
		run_number: run.run_number,
		repo: run.repo_name,
		ref: run.ref,
		sha: run.sha,
		event: run.event,
		state: run.state,
		agent_name: run.agent_name,
		started_at: run.started_at,
		finished_at: run.finished_at,
		duration_ms: run.duration_ms,
	};
}

/** Registers the 7 run/agent/repo tools on server, all scoped to installationId. */
export function registerMcpTools(server: McpServer, env: Env, installationId: number): void {
	const t = tenantDb(env.DB, installationId);

	server.registerTool(
		"list_runs",
		{
			description:
				"List runs for this installation, newest first. Filtering by repo or state uses offset pagination (offset); with neither filter, before (a run's run_rowid) pages by cursor instead.",
			inputSchema: {
				repo: z.string().optional().describe("owner/repo to filter to"),
				state: z.string().optional().describe("Run state to filter to, e.g. running, success, failed, cancelled"),
				limit: z.number().int().min(1).max(100).optional().describe("Max runs to return (default 20, max 100)"),
				before: z.number().int().optional().describe("Only used without repo/state: return runs older than this run_rowid"),
				offset: z.number().int().min(0).optional().describe("Only used with repo/state: rows to skip (default 0)"),
			},
		},
		async ({ repo, state, limit, before, offset }) => {
			const take = Math.min(limit ?? 20, 100);
			let repoId: number | undefined;
			if (repo !== undefined) {
				const row = await getRepoByFullName(t, repo);
				if (!row) return textResult({ runs: [] });
				repoId = row.repo_id;
			}
			const rows =
				repoId !== undefined || state !== undefined
					? await listRunsFiltered(t, take, { repoId, state }, offset ?? 0)
					: await listRunsPage(t, take, before);
			return textResult({ runs: rows.map(formatRun) });
		},
	);

	server.registerTool(
		"get_run",
		{
			description: "Get one run by id, with its jobs.",
			inputSchema: { run_id: z.string() },
		},
		async ({ run_id }) => {
			const run = await resolveRun(t, run_id);
			if (!run) return textResult({ error: "not_found" }, true);
			const jobs = await listJobsOfRun(t, run_id);
			return textResult({
				...formatRun(run),
				reason: run.reason,
				author_login: run.author_login,
				commit_title: run.commit_title,
				trust_refused: run.trust_refused,
				jobs: jobs.map((job) => ({
					name: job.name,
					state: job.state,
					step: job.step,
					step_index: job.step_index,
					steps_total: job.steps_total,
					duration_ms: job.duration_ms,
				})),
			});
		},
	);

	server.registerTool(
		"get_run_logs",
		{
			description: "Get a job's log text for a run. available: false when the agent has not uploaded it yet.",
			inputSchema: { run_id: z.string(), job: z.string() },
		},
		async ({ run_id, job }) => {
			if (!isRunId(run_id)) return textResult({ error: "not_found" }, true);
			const jobRow = await getJobOfRun(t, run_id, job);
			if (!jobRow) return textResult({ error: "not_found" }, true);
			if (jobRow.log_key === null) return textResult({ available: false });
			const object = await env.LOGS.get(logKey(installationId, run_id, job));
			if (!object) return textResult({ available: false });
			const { text, truncated } = await readRenderable(object.body);
			return textResult({ available: true, text, truncated });
		},
	);

	server.registerTool(
		"cancel_run",
		{
			description: "Cancel a run that has not finished.",
			inputSchema: { run_id: z.string() },
		},
		async ({ run_id }) => {
			const run = await resolveRun(t, run_id);
			if (!run) return textResult({ error: "not_found" }, true);
			const outcome = await cancelRun(env, t, run, Date.now());
			return textResult({ run_id, outcome }, outcome === "not_open");
		},
	);

	server.registerTool(
		"retry_run",
		{
			description: "Retry a finished run as a new attempt on its target repo and ref.",
			inputSchema: { run_id: z.string() },
		},
		async ({ run_id }) => {
			const run = await resolveRun(t, run_id);
			if (!run) return textResult({ error: "not_found" }, true);
			const repo = await getRepo(t, run.repo_id);
			if (!repo) return textResult({ error: "repo_not_found" }, true);
			const target: ResolvedRepo = { installationId, repoId: repo.repo_id, fullName: repo.full_name, defaultBranch: repo.default_branch };
			const outcome = await retryRun(env, commandGitHub(env), target, run);
			return textResult({ run_id, ...outcome }, outcome.kind !== "retried");
		},
	);

	server.registerTool("list_agents", { description: "List agents paired to this installation." }, async () => {
		const rows = await listAgents(t);
		return textResult({
			agents: rows.map((agent) => ({
				agent_id: agent.agent_id,
				name: agent.name,
				hostname: agent.hostname,
				os: agent.os,
				os_release: agent.os_release,
				arch: agent.arch,
				agent_version: agent.agent_version,
				status: agent.status,
				last_seen_at: agent.last_seen_at,
				revoked_at: agent.revoked_at,
				budget_cpus: agent.budget_cpus,
				budget_memory_bytes: agent.budget_memory_bytes,
			})),
		});
	});

	server.registerTool("list_repositories", { description: "List repositories this installation has configured." }, async () => {
		const rows = await listRepos(t);
		return textResult({ repositories: rows.map((repo) => ({ repo_id: repo.repo_id, full_name: repo.full_name, default_branch: repo.default_branch })) });
	});
}
