import { describe, expect, it } from "vitest";
import { aggregateFor, chunkAnnotations, configCheck, jobCheck, jobToCheck, toGithubAnnotation } from "../../src/checks/map";
import type { Annotation, JobView, PendingReason, RunView } from "../../src/sinks/types";
import { S } from "../../src/strings";

const HUB = "https://hub.test";

function runView(over: Partial<RunView> = {}): RunView {
  return {
    installationId: 42,
    repoId: 1001,
    repo: "acme/widgets",
    triggerId: "trg_1",
    runId: "run_1",
    sha: "1".repeat(40),
    shortSha: "1111111",
    event: "push",
    target: "checks",
    state: "running",
    commitTitle: "Add widget sizing",
    authorLogin: "alice",
    jobs: [],
    ...over,
  };
}

describe("aggregateFor", () => {
  const blocking: [PendingReason, string][] = [
    ["agent_offline", "Agent offline"],
    ["no_agent", "No agent paired"],
    ["daily_cap", "Daily run limit reached"],
    ["fork_gated", "Waiting for approval"],
    ["fork_never", "Fork pull requests are disabled"],
    ["suspended", "Installation suspended"],
  ];

  it.each(blocking)("pending %s concludes action_required titled %s", (reason, title) => {
    const view = aggregateFor(runView({ state: "pending", reason }), HUB);
    expect(view).toMatchObject({ status: "completed", conclusion: "action_required", title });
    expect(view.summary).not.toBe("");
  });

  it("links the pairing page when no agent is paired", () => {
    expect(aggregateFor(runView({ state: "pending", reason: "no_agent" }), HUB).summary).toContain(`${HUB}/start`);
  });

  it("names the daily cap", () => {
    expect(aggregateFor(runView({ state: "pending", reason: "daily_cap" }), HUB).summary).toContain("500 runs");
  });

  it("a gated fork run without a reason still waits for approval", () => {
    expect(aggregateFor(runView({ state: "gated" }), HUB)).toMatchObject({ conclusion: "action_required", title: "Waiting for approval" });
  });

  it("succeeds when jobs succeed or skip, ignoring the neutral _config job", () => {
    const jobs: JobView[] = [
      { name: "_config", state: "failed" },
      { name: "lint", state: "success" },
      { name: "test", state: "skipped" },
    ];
    const view = aggregateFor(runView({ state: "success", jobs }), HUB);
    expect(view).toMatchObject({ status: "completed", conclusion: "success" });
    expect(view.summary).not.toContain("_config");
  });

  it("fails when any job fails and names it", () => {
    const jobs: JobView[] = [
      { name: "lint", state: "success" },
      { name: "test", state: "failed" },
    ];
    expect(aggregateFor(runView({ state: "failed", jobs }), HUB)).toMatchObject({ status: "completed", conclusion: "failure", title: S.checks.failedJobs(["test"]) });
    expect(aggregateFor(runView({ state: "success", jobs }), HUB)).toMatchObject({ conclusion: "failure" });
  });

  it("a cancelled job cancels an otherwise finished run", () => {
    const jobs: JobView[] = [
      { name: "lint", state: "success" },
      { name: "test", state: "cancelled" },
    ];
    expect(aggregateFor(runView({ state: "success", jobs }), HUB)).toMatchObject({ conclusion: "cancelled" });
  });

  it("queued and running runs are in progress and list job states", () => {
    const jobs: JobView[] = [
      { name: "lint", state: "success", durationMs: 1200 },
      { name: "test", state: "running" },
    ];
    expect(aggregateFor(runView({ state: "queued" }), HUB)).toMatchObject({ status: "in_progress" });
    const view = aggregateFor(runView({ state: "running", jobs }), HUB);
    expect(view.status).toBe("in_progress");
    expect(view.summary).toBe([S.checks.jobLine("lint", "Passed", "1s"), S.checks.jobLine("test", "Running")].join("\n"));
  });

  it("superseded and interrupted runs are cancelled", () => {
    expect(aggregateFor(runView({ state: "superseded" }), HUB)).toMatchObject({ status: "completed", conclusion: "cancelled", summary: S.checks.superseded });
    expect(aggregateFor(runView({ state: "interrupted" }), HUB)).toMatchObject({ status: "completed", conclusion: "cancelled" });
  });

  it("a run without .zeroci.yml is skipped with the no checks title", () => {
    expect(aggregateFor(runView({ state: "skipped", reason: "no_config" }), HUB)).toMatchObject({ conclusion: "skipped", title: S.noChecks });
  });
});

describe("job checks", () => {
  it("maps job states to check states", () => {
    expect(jobToCheck({ name: "t", state: "queued" })).toEqual({ status: "queued" });
    expect(jobToCheck({ name: "t", state: "running" })).toEqual({ status: "in_progress" });
    expect(jobToCheck({ name: "t", state: "success" })).toEqual({ status: "completed", conclusion: "success" });
    expect(jobToCheck({ name: "t", state: "failed" })).toEqual({ status: "completed", conclusion: "failure" });
    expect(jobToCheck({ name: "t", state: "failed", reason: "timeout" })).toEqual({ status: "completed", conclusion: "timed_out" });
    expect(jobToCheck({ name: "t", state: "skipped" })).toEqual({ status: "completed", conclusion: "skipped" });
    expect(jobToCheck({ name: "t", state: "cancelled" })).toEqual({ status: "completed", conclusion: "cancelled" });
  });

  it("titles a running job with its step and summarizes progress and duration", () => {
    const running = jobCheck({ name: "test", state: "running", step: "compile", stepIndex: 1, stepsTotal: 3 });
    expect(running).toMatchObject({ status: "in_progress", title: "Running: compile", summary: S.checks.stepProgress(2, 3, "compile") });
    const done = jobCheck({ name: "test", state: "success", durationMs: 75_000 });
    expect(done).toMatchObject({ status: "completed", conclusion: "success", title: "Passed", summary: S.checks.tookDuration("1m 15s") });
    expect(jobCheck({ name: "test", state: "queued" }).summary).toBe(S.checks.waitingToStart);
  });

  it("the config check is always neutral", () => {
    expect(configCheck({ name: "_config", state: "queued" })).toMatchObject({ status: "completed", conclusion: "neutral" });
    expect(configCheck({ name: "_config", state: "failed", reason: "jobs.test: unknown key" })).toMatchObject({
      conclusion: "neutral",
      title: S.checks.configInvalid,
      summary: "jobs.test: unknown key",
    });
  });
});

describe("annotations", () => {
  const annotation: Annotation = { path: "src/a.ts", start_line: 3, end_line: 4, level: "warning", message: "unused", title: "lint" };

  it("chunks 120 annotations as 50, 50, 20 in order", () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ ...annotation, start_line: i }));
    const chunks = chunkAnnotations(many);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 20]);
    expect(chunks.flat()).toEqual(many);
  });

  it("maps to GitHub's annotation shape", () => {
    expect(toGithubAnnotation(annotation)).toEqual({ path: "src/a.ts", start_line: 3, end_line: 4, annotation_level: "warning", message: "unused", title: "lint" });
  });
});
