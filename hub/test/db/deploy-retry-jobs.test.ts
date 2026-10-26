import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { acceptRun, insertRun, listJobsOfRun, type NewRun, upsertJob } from "../../src/db/runs";
import { tenantDb } from "../../src/db/tenant";
import { clearTables } from "./helpers";

const SHA = "a".repeat(40);

beforeEach(clearTables);

function deployRun(runId: string, triggerId: string, attempt: number): NewRun {
	return {
		run_id: runId,
		repo_id: 100,
		sha: SHA,
		ref: "refs/heads/main",
		event: "push",
		pr_number: null,
		env: "prod",
		attempt,
		trigger_id: triggerId,
		agent_id: "agt_1",
		state: attempt === 1 ? "failed" : "received",
		reason: null,
		author_login: null,
		commit_title: null,
		started_at: null,
		finished_at: null,
		duration_ms: null,
		log_key: null,
	};
}

it("a deploy retry starts with no jobs from the earlier attempt", async () => {
	const t = tenantDb(env.DB, 1);
	await insertRun(t, deployRun("agent-run", "trg-1", 1));
	await acceptRun(t, "trg-1", "agent-run", "agt_1");
	await upsertJob(t, { run_id: "agent-run", name: "deploy", state: "failed", step: "push", step_index: 2, steps_total: 3, duration_ms: 9000 });
	await upsertJob(t, { run_id: "agent-run", name: "dropped-later", state: "failed", step: null, step_index: null, steps_total: null, duration_ms: 5 });

	await insertRun(t, deployRun("trg-2", "trg-2", 2));
	expect(await acceptRun(t, "trg-2", "agent-run", "agt_1")).toBe(true);
	expect(await listJobsOfRun(t, "agent-run")).toEqual([]);
});
