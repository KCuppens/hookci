import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSinkConfig, getSinkConfigWithSecret, type SinkConfigWithSecret } from "../../src/db/sinks";
import { tenantDb } from "../../src/db/tenant";
import type { Clock } from "../../src/do/clock";
import { stableLogLink } from "../../src/logs/links";
import type { OutboxDelivery } from "../../src/sinks/deliverers";
import type { RunState, RunView } from "../../src/sinks/types";
import { buildWebhookPayload, signWebhook, type WebhookPayloadV1, webhookDeliverer } from "../../src/sinks/webhook";
import { TERMINAL } from "../../src/slack/badge";
import { clearTables } from "../db/helpers";

const INSTALLATION = 61;
const TARGET = "https://hooks.example.com/hookci";
const SECRET = "hciwh_" + "ab".repeat(32);
const t = tenantDb(env.DB, INSTALLATION);

interface Sent {
  url: string;
  init: RequestInit;
}

let at = 0;
const clock: Clock = { now: () => at };
let sent: Sent[];
let answer: () => Promise<Response>;
const saved = { fetcher: env.__TEST_FETCHER, clock: env.__TEST_CLOCK };
let cfg: SinkConfigWithSecret;

beforeEach(async () => {
  await clearTables();
  // An hour ahead of the wall clock, so the outbox's alarms only run when the test runs them.
  at = Date.now() + 3_600_000;
  sent = [];
  answer = async () => new Response(null, { status: 200 });
  env.__TEST_CLOCK = clock;
  env.__TEST_FETCHER = async (input, init) => {
    sent.push({ url: String(input), init: init ?? {} });
    return answer();
  };
  const row = await createSinkConfig(env, t, { kind: "webhook", repo: "org/api", target: TARGET, secret: SECRET, createdBy: "slack:T1:U1" });
  cfg = (await getSinkConfigWithSecret(env, t, row.id))!;
});

afterEach(() => {
  env.__TEST_FETCHER = saved.fetcher;
  env.__TEST_CLOCK = saved.clock;
});

function view(state: RunState, extra: Partial<RunView> = {}): RunView {
  return {
    installationId: INSTALLATION,
    repoId: 1,
    repo: "org/api",
    triggerId: "trg_1",
    runId: "run_1",
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    ref: "refs/heads/main",
    event: "push",
    target: "main",
    state,
    commitTitle: "Fix the build",
    authorLogin: "dev",
    startedAt: 1_700_000_000_000,
    jobs: [
      { name: "lint", state: "success", durationMs: 8200 },
      { name: "test", state },
    ],
    ...extra,
  };
}

function delivery(run: RunView, deliveryId = "01DELIVERY"): OutboxDelivery {
  return { installationId: INSTALLATION, sinkId: cfg.id, runId: run.triggerId, terminal: TERMINAL.has(run.state), payload: run, enqueuedAt: at, deliveryId };
}

function header(s: Sent, name: string): string | null {
  return new Headers(s.init.headers).get(name);
}

describe("webhookDeliverer", () => {
  it("POSTs the signed v1 payload with every header and answers ok on 200", async () => {
    const result = await webhookDeliverer.deliver(env, cfg, delivery(view("running")), 1);

    expect(result).toEqual({ kind: "ok" });
    expect(sent).toHaveLength(1);
    const s = sent[0]!;
    expect(s.url).toBe(TARGET);
    expect(s.init.method).toBe("POST");
    expect(s.init.redirect).toBe("manual");
    expect(s.init.signal).toBeInstanceOf(AbortSignal);
    const ts = Math.floor(at / 1000);
    expect(header(s, "Content-Type")).toBe("application/json");
    expect(header(s, "User-Agent")).toBe("HookCI-Hookshot/1");
    expect(header(s, "X-HookCI-Event")).toBe("run.updated");
    expect(header(s, "X-HookCI-Delivery")).toBe("01DELIVERY");
    expect(header(s, "X-HookCI-Timestamp")).toBe(String(ts));
    const body = String(s.init.body);
    expect(header(s, "X-HookCI-Signature")).toBe(await signWebhook(SECRET, ts, body));

    const payload = JSON.parse(body) as WebhookPayloadV1;
    expect(payload).toEqual({
      v: 1,
      type: "run.updated",
      delivery_id: "01DELIVERY",
      sent_at: new Date(at).toISOString(),
      run: {
        id: "run_1",
        repo: "org/api",
        sha: "a".repeat(40),
        ref: "refs/heads/main",
        event: "push",
        pr: null,
        target: "main",
        state: "running",
        terminal: false,
        jobs: [
          { name: "lint", state: "success", duration_ms: 8200 },
          { name: "test", state: "running", duration_ms: null },
        ],
        started_at: new Date(1_700_000_000_000).toISOString(),
        finished_at: null,
        log_url: null,
      },
    });
  });

  it("fails on 302 without following the redirect", async () => {
    answer = async () => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example.com/" } });

    expect(await webhookDeliverer.deliver(env, cfg, delivery(view("running")), 1)).toEqual({ kind: "fail", httpStatus: 302 });
    expect(sent.map((s) => s.url)).toEqual([TARGET]);
  });

  it("fails on other 4xx", async () => {
    answer = async () => new Response("nope", { status: 400 });

    expect(await webhookDeliverer.deliver(env, cfg, delivery(view("running")), 1)).toEqual({ kind: "fail", httpStatus: 400 });
  });

  it("retries a 429 after its Retry-After seconds", async () => {
    answer = async () => new Response(null, { status: 429, headers: { "Retry-After": "12" } });

    expect(await webhookDeliverer.deliver(env, cfg, delivery(view("running")), 1)).toEqual({ kind: "retry", httpStatus: 429, afterMs: 12_000 });
  });

  it("retries a 500", async () => {
    answer = async () => new Response(null, { status: 500 });

    expect(await webhookDeliverer.deliver(env, cfg, delivery(view("running")), 1)).toEqual({ kind: "retry", httpStatus: 500 });
  });

  it("retries a timeout and a network error", async () => {
    answer = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    expect(await webhookDeliverer.deliver(env, cfg, delivery(view("running")), 1)).toEqual({ kind: "retry" });

    answer = async () => {
      throw new TypeError("Network connection lost.");
    };
    expect(await webhookDeliverer.deliver(env, cfg, delivery(view("running")), 2)).toEqual({ kind: "retry" });
  });

  it("sends one request for two updates with the same run state", async () => {
    const run = view("running");
    expect(await webhookDeliverer.deliver(env, cfg, delivery(run, "01A"), 1)).toEqual({ kind: "ok" });
    expect(await webhookDeliverer.deliver(env, cfg, delivery({ ...run, currentJob: "test" }, "01B"), 1)).toEqual({ kind: "ok" });
    expect(sent).toHaveLength(1);

    await webhookDeliverer.deliver(env, cfg, delivery(view("success"), "01C"), 1);
    expect(sent.map((s) => header(s, "X-HookCI-Delivery"))).toEqual(["01A", "01C"]);
  });

  it("sends the state again when the earlier attempt did not succeed", async () => {
    answer = async () => new Response(null, { status: 503 });
    await webhookDeliverer.deliver(env, cfg, delivery(view("running")), 1);
    answer = async () => new Response(null, { status: 204 });

    expect(await webhookDeliverer.deliver(env, cfg, delivery(view("running")), 2)).toEqual({ kind: "ok" });
    expect(sent).toHaveLength(2);
  });

  it("puts the failed job's stable log link in log_url, else the first job's with a log", async () => {
    const jobs = [
      { name: "lint", state: "success" as const, logLink: stableLogLink(env, "run_1", "lint") },
      { name: "test", state: "failed" as const, logLink: stableLogLink(env, "run_1", "test") },
    ];
    await webhookDeliverer.deliver(env, cfg, delivery(view("failed", { jobs })), 1);
    const body = String(sent[0]!.init.body);
    expect(body).not.toContain("/logs/view");
    expect((JSON.parse(body) as WebhookPayloadV1).run.log_url).toBe(stableLogLink(env, "run_1", "test"));

    const passed = jobs.map((job) => ({ ...job, state: "success" as const }));
    expect(buildWebhookPayload(view("success", { jobs: passed }), "01X", new Date(at)).run.log_url).toBe(stableLogLink(env, "run_1", "lint"));
    expect(buildWebhookPayload(view("success", { jobs: [{ name: "lint", state: "success" }] }), "01X", new Date(at)).run.log_url).toBeNull();
  });

  it("refuses a private target without sending and disables the config", async () => {
    const result = await webhookDeliverer.deliver(env, { ...cfg, target: "https://169.254.169.254/latest" }, delivery(view("running")), 1);

    expect(result).toEqual({ kind: "fail", disable: "webhook_url_private_host" });
    expect(sent).toHaveLength(0);
  });
});

describe("webhook through the outbox", () => {
  it("disables the config on 410 Gone", async () => {
    answer = async () => new Response(null, { status: 410 });
    const outbox = env.SINK_OUTBOX.get(env.SINK_OUTBOX.idFromName(`${INSTALLATION}:${cfg.id}`));
    const run = view("failed");

    await outbox.enqueue({ installationId: INSTALLATION, sinkId: cfg.id, runId: run.triggerId, terminal: true, payload: run, enqueuedAt: at });
    await runDurableObjectAlarm(outbox);

    expect(sent).toHaveLength(1);
    const after = await getSinkConfigWithSecret(env, t, cfg.id);
    expect(after?.disabledAt).toBe(at);
    expect(after?.disabledReason).toBe("webhook_gone");
  });
});
