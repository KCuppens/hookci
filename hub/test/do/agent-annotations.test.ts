import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countRunAnnotations, listRunAnnotations } from "../../src/db/annotations";
import { upsertInstallation } from "../../src/db/installations";
import { QUOTAS } from "../../src/quotas";
import type { TriggerRequest } from "../../src/webhook/route";
import { clearTables } from "../db/helpers";
import { type RecordingSink, recordSink } from "../sinks/recording";
import { type Agent, type AgentSocket, connect, seedAgent } from "./agent-socket";

const ACME = 42;
const OTHER = 43;

const TRIGGER: TriggerRequest = {
  installationId: ACME,
  repoId: 1001,
  repo: "acme/widgets",
  sha: "1".repeat(40),
  ref: "refs/heads/feature",
  event: "pull_request",
  pr: { number: 7, headRef: "feature", baseRef: "main", headRepoFullName: "acme/widgets", fork: false, authorLogin: "alice" },
  baseSha: "0".repeat(39) + "1",
  authorLogin: "alice",
  commitTitle: "Add widget sizing",
  defaultBranch: "main",
  target: "checks",
  trust: "trusted",
};

/** A connected agent of installationId with a run accepted as runId. */
async function agentWithRun(installationId: number, runId: string): Promise<{ agent: Agent; sock: AgentSocket }> {
  const agent = await seedAgent(installationId);
  const sock = await connect(agent);
  expect(await sock.hello()).toMatchObject({ type: "welcome" });
  const res = await agent.stub.fetch("https://do/trigger", {
    method: "POST",
    headers: { "x-hookci-agent-id": agent.agentId },
    body: JSON.stringify({ ...TRIGGER, installationId } satisfies TriggerRequest),
  });
  expect(res.status).toBe(202);
  const { trigger_id } = await res.json<{ trigger_id: string }>();
  expect(await sock.next()).toMatchObject({ type: "trigger", trigger_id });
  expect(await sock.request({ type: "accepted", trigger_id, run_id: runId })).toEqual([]);
  return { agent, sock };
}

function annotations(runId: string, job: unknown, items: unknown): Record<string, unknown> {
  return { type: "annotations", agent_seq: 1, run_id: runId, job, items };
}

function stored(installationId: number, runId: string) {
  return listRunAnnotations(env.DB, installationId, runId);
}

describe("annotations frames", () => {
  const cleanups: (() => void)[] = [];
  let sink: RecordingSink;

  beforeEach(async () => {
    await clearTables();
    await upsertInstallation(env.DB, { id: ACME, account_login: "acme", account_type: "Organization", account_id: ACME * 10, created_at: 1 });
    await upsertInstallation(env.DB, { id: OTHER, account_login: "other", account_type: "Organization", account_id: OTHER * 10, created_at: 1 });
    sink = recordSink();
    cleanups.push(sink.undo);
  });

  afterEach(() => {
    for (const undo of cleanups.splice(0)) undo();
    vi.restoreAllMocks();
  });

  it("stores a valid frame and still hands it to the sinks", async () => {
    const { sock } = await agentWithRun(ACME, "run_a");
    await sock.request(annotations("run_a", "lint", [{ path: "src/a.ts", line: 3, column: 5, level: "failure", message: "unused", title: "no-unused" }]));

    expect(await stored(ACME, "run_a")).toEqual([
      expect.objectContaining({ job: "lint", level: "failure", path: "src/a.ts", start_line: 3, end_line: 3, title: "no-unused", message: "unused" }),
    ]);
    expect(sink.calls).toContainEqual({
      op: "onAnnotations",
      run: expect.objectContaining({ runId: "run_a" }),
      job: "lint",
      annotations: [{ path: "src/a.ts", start_line: 3, end_line: 3, level: "failure", message: "unused", title: "no-unused" }],
    });
  });

  it("cuts an oversized message, path and title before storing", async () => {
    const { sock } = await agentWithRun(ACME, "run_a");
    const huge = "x".repeat(100_000);
    await sock.request(annotations("run_a", "lint", [{ path: huge, line: 1, level: "warning", message: huge, title: huge }]));

    const [row] = await stored(ACME, "run_a");
    expect(row?.path).toHaveLength(QUOTAS.storedAnnotationPathChars);
    expect(row?.title).toHaveLength(QUOTAS.storedAnnotationTitleChars);
    expect(row?.message).toHaveLength(QUOTAS.storedAnnotationMessageChars);
  });

  it("stores 50 of a flooding job, then at most 200 for the run", async () => {
    const { sock } = await agentWithRun(ACME, "run_a");
    const flood = Array.from({ length: 5000 }, (_, i) => ({ path: `f${i}.go`, line: i + 1, level: "notice", message: "m" }));
    await sock.request(annotations("run_a", "j1", flood));
    expect((await countRunAnnotations(env.DB, ACME, "run_a")).total).toBe(QUOTAS.storedAnnotationsPerJob);

    for (const job of ["j2", "j3", "j4", "j5", "j6"]) await sock.request(annotations("run_a", job, flood.slice(0, 80)));
    expect((await countRunAnnotations(env.DB, ACME, "run_a")).total).toBe(QUOTAS.storedAnnotationsPerRun);
  });

  it("stores nothing for a run the agent does not hold, even one of another installation", async () => {
    const mine = await agentWithRun(ACME, "run_a");
    const theirs = await agentWithRun(OTHER, "run_b");

    await theirs.sock.request(annotations("run_a", "lint", [{ path: "evil.go", line: 1, level: "failure", message: "planted" }]));
    await mine.sock.request(annotations("run_b", "lint", [{ path: "evil.go", line: 1, level: "failure", message: "planted" }]));
    await mine.sock.request(annotations("run_zzz", "lint", [{ path: "evil.go", line: 1, level: "failure", message: "planted" }]));

    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM annotations").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("drops malformed items, keeps the good ones and keeps the connection open", async () => {
    const { sock } = await agentWithRun(ACME, "run_a");
    await sock.request(
      annotations("run_a", "lint", [
        { path: "", line: 1, level: "failure", message: "no path" },
        { path: "a.go", line: -4, level: "failure", message: "negative line" },
        { path: "a.go", line: 2, level: "fatal", message: "unknown level" },
        { path: "a.go", line: 3, level: "failure", message: 12 },
        null,
        "text",
        { path: "ok.go", line: 4, level: "warning", message: "fine" },
      ]),
    );
    await sock.request(annotations("run_a", "lint", "not a list"));
    await sock.request(annotations("run_a", "lint", { path: "a.go" }));
    await sock.request(annotations("run_a", 5, [{ path: "nojob.go", line: 1, level: "notice", message: "x" }]));

    expect((await stored(ACME, "run_a")).map((r) => r.path)).toEqual(["ok.go"]);
    // The socket still works: a later frame is acked and stored.
    await sock.request(annotations("run_a", "test", [{ path: "later.go", line: 1, level: "notice", message: "x" }]));
    expect((await stored(ACME, "run_a")).map((r) => r.path)).toEqual(["ok.go", "later.go"]);
  });
});
