import { describe, expect, it } from "vitest";
import type { JobView, RunView } from "../src/sinks/types";
import { formatDuration, renderBadge } from "../src/slack/badge";

const LINT: JobView = { name: "lint", state: "success", durationMs: 20_000, logLink: "https://hub.test/runs/r1/logs?job=lint" };

const RUN: RunView = {
  installationId: 4242,
  repoId: 900,
  repo: "acme/api",
  triggerId: "01HAAAAAAAAAAAAAAAAAAAAAAA",
  sha: "abcdef1234567890abcdef1234567890abcdef12",
  shortSha: "abcdef1",
  event: "push",
  target: "checks",
  state: "success",
  commitTitle: "Fix <script> & stuff",
  authorLogin: "octocat",
  durationMs: 124_000,
  jobs: [
    LINT,
    { name: "test", state: "success", durationMs: 104_000 },
  ],
};

describe("renderBadge", () => {
  it("shows progress and the current job while running", () => {
    const badge = renderBadge({ ...RUN, state: "running", durationMs: undefined, currentJob: "test", jobs: [LINT, { name: "test", state: "running" }] });

    expect(badge.text).toBe(':large_yellow_circle: acme/api · checks · abcdef1 "Fix &lt;script&gt; &amp; stuff" · 1/2 test');
  });

  it("shows queued before any job is known", () => {
    expect(renderBadge({ ...RUN, state: "received", durationMs: undefined, jobs: [] }).text).toBe(
      ':large_yellow_circle: acme/api · checks · abcdef1 "Fix &lt;script&gt; &amp; stuff" · queued',
    );
  });

  it("shows duration, job count and log link on success", () => {
    expect(renderBadge(RUN)).toEqual({
      text: ":large_green_circle: checks · abcdef1 · 2m04s · 2/2 jobs passed · <https://hub.test/runs/r1/logs?job=lint|log>",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: ":large_green_circle: checks · abcdef1 · 2m04s · 2/2 jobs passed · <https://hub.test/runs/r1/logs?job=lint|log>" } },
      ],
    });
  });

  it("names the failed jobs on failure and links the failed job's log", () => {
    const failed: JobView = { name: "test", state: "failed", logLink: "https://hub.test/runs/r1/logs?job=test" };
    const badge = renderBadge({ ...RUN, state: "failed", durationMs: 41_200, jobs: [LINT, failed] });

    expect(badge.text).toBe(":red_circle: checks · abcdef1 · 41.2s · failed: test · <https://hub.test/runs/r1/logs?job=test|log>");
  });

  it("prefers the jobs' own summaries", () => {
    const badge = renderBadge({ ...RUN, jobs: [{ name: "test", state: "success", summary: "412 tests passed" }] });

    expect(badge.text).toBe(":large_green_circle: checks · abcdef1 · 2m04s · 412 tests passed");
  });

  it("says the agent was offline", () => {
    expect(renderBadge({ ...RUN, state: "pending", reason: "agent_offline", durationMs: undefined, jobs: [] }).text).toBe(
      ":black_circle: agent offline: checks did not run",
    );
  });

  it("says the daily cap stopped the run", () => {
    expect(renderBadge({ ...RUN, state: "pending", reason: "daily_cap", durationMs: undefined, jobs: [] }).text).toBe(
      ":black_circle: daily run limit reached: checks did not run",
    );
  });

  it("marks the test badge and drops its log link", () => {
    expect(renderBadge(RUN, { test: true })).toEqual({
      text: ":large_green_circle: checks · abcdef1 · 2m04s · 2/2 jobs passed (test)",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: ":large_green_circle: checks · abcdef1 · 2m04s · 2/2 jobs passed (test)" } },
        { type: "context", elements: [{ type: "mrkdwn", text: "Test badge for acme/api: its runs post here like this." }] },
      ],
    });
  });

  it("shows a cancelled run in white with its state", () => {
    expect(renderBadge({ ...RUN, state: "cancelled", durationMs: 9_000 }).text).toBe(":white_circle: checks · abcdef1 · cancelled · 9.0s");
  });
});

describe("formatDuration", () => {
  it("uses tenths under a minute, m and ss under an hour, then h", () => {
    expect(formatDuration(124_000)).toBe("2m04s");
    expect(formatDuration(41_200)).toBe("41.2s");
    expect(formatDuration(59_940)).toBe("59.9s");
    expect(formatDuration(59_960)).toBe("1m00s");
    expect(formatDuration(3_723_000)).toBe("1h02m03s");
  });
});
