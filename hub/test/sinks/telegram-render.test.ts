import { describe, expect, it } from "vitest";
import type { JobView, RunState, RunView } from "../../src/sinks/types";
import { escapeTelegramHtml, redactTelegramUrl, renderTelegram, TELEGRAM_MAX_CHARS } from "../../src/sinks/telegram";

function view(state: RunState, over: Partial<RunView> = {}): RunView {
  return {
    installationId: 1,
    repoId: 1,
    repo: "org/api",
    triggerId: "trg_1",
    runId: "run_1",
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    ref: "refs/heads/main",
    event: "push",
    target: "checks",
    state,
    commitTitle: "Fix the build",
    authorLogin: "dev",
    jobs: [],
    ...over,
  };
}

const failedJob = (tail: string[], over: Partial<JobView> = {}): JobView => ({ name: "test", state: "failed", durationMs: 12_300, tail, ...over });

describe("renderTelegram", () => {
  it.each([
    ["queued", view("queued"), "Queued"],
    ["running", view("running"), "Running"],
    ["success", view("success", { jobs: [{ name: "build", state: "success" }] }), "Passed"],
    ["failure", view("failed", { jobs: [{ name: "build", state: "failed" }] }), "Failed"],
    ["cancelled", view("cancelled"), "Cancelled"],
    ["timed_out", view("failed", { jobs: [{ name: "build", state: "failed", reason: "timeout" }] }), "Timed out"],
    ["action_required", view("gated", { reason: "fork_gated", event: "pull_request", prNumber: 7 }), "Action required"],
  ])("leads a %s run with its status word, repo and short SHA", (_, run, word) => {
    const { text, parseMode } = renderTelegram(run, {});
    expect(parseMode).toBe("HTML");
    expect(text.split("\n")[0]).toBe(`<b>${word}</b> org/api <code>aaaaaaa</code>`);
  });

  it("lists ref, trigger, environment and one line per job, without the config job", () => {
    const run = view("running", {
      event: "pull_request",
      prNumber: 42,
      target: "deploy:staging",
      jobs: [
        { name: "_config", state: "success" },
        { name: "build", state: "success", durationMs: 41_200 },
        { name: "test", state: "running" },
        { name: "lint", state: "queued" },
      ],
    });
    expect(renderTelegram(run, {}).text.split("\n")).toEqual([
      "<b>Running</b> org/api <code>aaaaaaa</code>",
      "Ref: main",
      "PR #42",
      "Environment: staging",
      "build: Passed (41.2s)",
      "test: Running",
      "lint: Queued",
    ]);
  });

  it("says why an action_required run waits", () => {
    const text = renderTelegram(view("pending", { reason: "agent_offline" }), {}).text;
    expect(text).toContain("<b>Action required</b>");
    expect(text).toContain("The agent is offline: the run starts when it reconnects.");
  });

  it("escapes HTML in job names and log lines", () => {
    const run = view("failed", { jobs: [failedJob(["<script>alert(1)</script>"], { name: "<script>x</script>" })] });
    const text = renderTelegram(run, {}).text;
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;x&lt;/script&gt;: Failed (12.3s)");
    expect(text).toContain("<pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre>");
  });

  it("escapes &, <, > and double quotes", () => {
    expect(escapeTelegramHtml(`a & <b> "c"`)).toBe("a &amp; &lt;b&gt; &quot;c&quot;");
  });

  it("shows only the last 10 lines of a 20-line tail", () => {
    const tail = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const text = renderTelegram(view("failed", { jobs: [failedJob(tail)] }), {}).text;
    const pre = text.slice(text.indexOf("<pre>") + 5, text.indexOf("</pre>"));
    expect(pre.split("\n")).toEqual(tail.slice(10));
  });

  it("shows no tail for a run that did not fail", () => {
    const run = view("running", { jobs: [{ name: "test", state: "running", tail: ["boom"] }] });
    expect(renderTelegram(run, {}).text).not.toContain("<pre>");
  });

  it("keeps a 100 KB tail within 4096 characters and its block within 3500", () => {
    const tail = Array.from({ length: 10 }, () => "x".repeat(10_000));
    const text = renderTelegram(view("failed", { jobs: [failedJob(tail)] }), {}).text;
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    const pre = text.slice(text.indexOf("<pre>") + 5, text.indexOf("</pre>"));
    expect(pre.length).toBeGreaterThan(0);
    expect(pre.length).toBeLessThanOrEqual(3500);
  });

  it("drops the tail before job lines, then ends the job lines with how many it left out", () => {
    const jobs: JobView[] = Array.from({ length: 300 }, (_, i) => ({ name: `job-${i}-${"n".repeat(20)}`, state: "failed", tail: ["boom"] }));
    const lines = renderTelegram(view("failed", { jobs }), {}).text.split("\n");
    expect(lines.join("\n").length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(lines.join("\n")).not.toContain("<pre>");
    const last = lines.at(-1) ?? "";
    const omitted = Number(/^\.\.\. and (\d+) more jobs$/.exec(last)?.[1]);
    expect(omitted).toBeGreaterThan(0);
    expect(lines.filter((line) => line.startsWith("job-"))).toHaveLength(300 - omitted);
  });

  it("links the run's log page under logLinkBase, opened at the failed job", () => {
    const run = view("failed", { jobs: [{ name: "build", state: "success" }, failedJob([])] });
    const text = renderTelegram(run, { logLinkBase: "https://hub.example/" }).text;
    expect(text.split("\n").at(-1)).toBe('<a href="https://hub.example/runs/run_1/logs?job=test">View logs</a>');
  });

  it("links run.logUrl when the run has one, escaped", () => {
    const text = renderTelegram(view("success", { logUrl: "https://hub.example/runs/run_1/logs?a=1&b=2" }), {}).text;
    expect(text).toContain('<a href="https://hub.example/runs/run_1/logs?a=1&amp;b=2">View logs</a>');
  });

  it("has no link without logUrl or logLinkBase", () => {
    expect(renderTelegram(view("success"), {}).text).not.toContain("<a ");
  });
});

describe("redactTelegramUrl", () => {
  it("masks the bot token", () => {
    expect(redactTelegramUrl("https://api.telegram.org/bot123456:SECRET-TOKEN/sendMessage")).toBe("https://api.telegram.org/bot***/sendMessage");
  });
});
