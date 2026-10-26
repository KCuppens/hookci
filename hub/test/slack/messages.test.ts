import { describe, expect, it } from "vitest";
import type { Block } from "../../src/slack/blocks";
import { renderAlert, renderDeployFailure, renderJobReply, renderOfflineDm, renderRunMessage, type SlackMessage, TAIL_LINES, tailBlock } from "../../src/slack/messages";
import type { PendingReason, RunState, RunView } from "../../src/sinks/types";
import { S } from "../../src/strings";

const STATES: RunState[] = [
  "received",
  "gated",
  "pending",
  "superseded",
  "queued",
  "running",
  "success",
  "failed",
  "cancelled",
  "skipped",
  "interrupted",
  "verifying",
  "rolling_back",
];
const REASONS: PendingReason[] = ["no_agent", "agent_offline", "daily_cap", "fork_gated", "fork_never", "suspended", "no_config"];
const WORDS = Object.values(S.slack.state);

function runView(over: Partial<RunView> = {}): RunView {
  return {
    installationId: 1,
    repoId: 1,
    repo: "acme/widgets",
    triggerId: "trg_1",
    runId: "run_1",
    sha: "3".repeat(40),
    shortSha: "3333333",
    ref: "refs/heads/main",
    event: "push",
    target: "checks",
    state: "running",
    commitTitle: "Fix the build",
    authorLogin: "alice",
    durationMs: 61_000,
    jobs: [{ name: "test", state: "running", step: "unit", stepIndex: 2, stepsTotal: 4 }],
    currentJob: "test",
    ...over,
  };
}

function blockTexts(blocks: Block[]): string[] {
  return blocks.flatMap((b) => (b.type === "section" ? [b.text.text] : b.type === "context" ? b.elements.map((e) => e.text) : []));
}

/** Every message the sink can send, over every state and pending reason. */
function everyMessage(): SlackMessage[] {
  const runs = [
    ...STATES.map((state) => runView({ state })),
    ...REASONS.map((reason) => runView({ state: "pending", reason })),
    runView({ state: "gated", reason: "fork_gated" }),
  ];
  const agent = { agentId: "agt_1", installationId: 1, name: "builder", lastSeenAt: 1_700_000_000_000 };
  return [
    ...runs.flatMap((run) => [renderRunMessage(run, { notify: "normal" }), renderRunMessage(run, { notify: "quiet" })]),
    ...STATES.map((state) => renderJobReply(runView(), { name: "test", state, durationMs: 1200, summary: "3 failed", reason: "exit 1" })),
    renderAlert(runView({ state: "failed" }), { name: "test", state: "failed", step: "unit" }, ["boom"], "U0ALICE", "https://logs.test/1"),
    renderAlert(runView({ state: "failed" }), { name: "test", state: "failed" }, [], null, null),
    renderOfflineDm(agent, [runView({ state: "pending", reason: "agent_offline" })]),
  ];
}

describe("Slack messages", () => {
  it("start every text with a plain state word and keep dashes and emoji out of it", () => {
    for (const msg of everyMessage()) {
      expect(WORDS.some((word) => msg.text.startsWith(`${word}:`)), msg.text).toBe(true);
      expect(msg.text).not.toMatch(/[\u2013\u2014]|\p{Extended_Pictographic}|:[a-z_]+:/u);
    }
  });

  it("puts the badge emoji in the blocks only", () => {
    const msg = renderRunMessage(runView({ state: "success" }), { notify: "normal" });
    expect(blockTexts(msg.blocks)[0]).toMatch(/^:large_green_circle: \*Passed\*/);
    expect(msg.text).toBe("Passed: acme/widgets 3333333 on main, Fix the build");
  });

  it("renders no_config as the exact hint", () => {
    const msg = renderRunMessage(runView({ state: "pending", reason: "no_config" }), { notify: "normal" });
    expect(blockTexts(msg.blocks)).toContain("No checks detected: add `.hookci.yml`");
  });

  it("links the run page in the run message, the alert and the deploy failure", () => {
    const runLink = "https://hub.test/42/runs/run_1";
    const run = runView({ state: "failed", runLink, jobs: [{ name: "test", state: "failed", logLink: "https://hub.test/runs/run_1/logs?job=test" }] });
    expect(blockTexts(renderRunMessage(run, { notify: "normal" }).blocks).join("\n")).toContain(`<${runLink}|run>`);
    expect(blockTexts(renderAlert(run, run.jobs[0]!, ["boom"], null, "https://logs.test/1").blocks).join("\n")).toContain(`https://logs.test/1|log> · <${runLink}|run>`);
    const deploy = { env: "staging", sha: "abc1234", state: "failed" as const, logUrl: "https://logs.test/2", runUrl: runLink };
    expect(JSON.stringify(renderDeployFailure("acme/widgets", deploy, [], null).blocks)).toContain(`<${runLink}|run>`);
  });

  it("keeps the last 40 tail lines, each cut to 300 chars, in a block under 2900 chars", () => {
    const tail = Array.from({ length: 60 }, (_, i) => `${i}:`.padEnd(400, "x"));
    const block = tailBlock(tail);
    expect(block.length).toBeLessThan(2900);
    const lines = block.split("\n").slice(1, -1);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(TAIL_LINES);
    expect(lines.every((line) => line.length <= 300)).toBe(true);
    expect(lines.at(-1)).toMatch(/^59:x+\.\.\.$/);

    const alert = renderAlert(runView({ state: "failed" }), { name: "test", state: "failed" }, tail, "U0ALICE", null);
    for (const text of blockTexts(alert.blocks)) expect(text.length).toBeLessThan(3000);
  });

  it("keeps all 40 short tail lines and drops the older ones", () => {
    const lines = tailBlock(Array.from({ length: 50 }, (_, i) => `line ${i}`)).split("\n").slice(1, -1);
    expect(lines).toEqual(Array.from({ length: 40 }, (_, i) => `line ${i + 10}`));
  });
});
