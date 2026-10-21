import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertInstallation } from "../../src/db/installations";
import { upsertRepos } from "../../src/db/repos";
import { createSinkConfig, getSinkConfigWithSecret, type SinkConfigRow } from "../../src/db/sinks";
import { tenantDb } from "../../src/db/tenant";
import type { TriggerRequest } from "../../src/webhook/route";
import { testClock } from "../clock";
import { clearTables } from "../db/helpers";
import { connect, seedAgent } from "../do/agent-socket";
import type { FakeService } from "../fakes/http";
import { botError, botMethod, createFakeTelegram, FAKE_TELEGRAM_API } from "../fakes/telegram";

const INSTALLATION = 62;
const t = tenantDb(env.DB, INSTALLATION);

const TRIGGER: TriggerRequest = {
  installationId: INSTALLATION,
  repoId: 1001,
  repo: "acme/widgets",
  sha: "1".repeat(40),
  ref: "refs/heads/main",
  event: "push",
  authorLogin: "alice",
  commitTitle: "Add widget sizing",
  defaultBranch: "main",
  target: "checks",
  trust: "trusted",
};

type Row = Record<string, unknown>;

let tg: FakeService;
let cfg: SinkConfigRow;
let saved: { fetcher: typeof env.__TEST_FETCHER; base: string };

beforeEach(async () => {
  await clearTables();
  await upsertInstallation(env.DB, { id: INSTALLATION, account_login: "acme", account_type: "Organization", account_id: INSTALLATION * 10, created_at: 1 });
  await upsertRepos(t, [{ repo_id: TRIGGER.repoId, full_name: TRIGGER.repo, default_branch: "main" }]);
  tg = createFakeTelegram();
  saved = { fetcher: env.__TEST_FETCHER, base: env.TELEGRAM_API_BASE };
  env.__TEST_FETCHER = tg.fetcher;
  env.TELEGRAM_API_BASE = FAKE_TELEGRAM_API;
  cfg = await createSinkConfig(env, t, { kind: "telegram", repo: "acme/widgets", target: "-100123", secret: "123456:SECRET-TOKEN", createdBy: "slack:T1:U1" });
  // The checks sink also reaches the fake and fails; its error reports are not under test.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  env.__TEST_FETCHER = saved.fetcher;
  env.TELEGRAM_API_BASE = saved.base;
  vi.restoreAllMocks();
});

function deliveries(): Promise<Row[]> {
  return env.DB.prepare("SELECT status, http_status FROM sink_deliveries WHERE installation_id = ?1 AND sink_id = ?2 ORDER BY at, attempt")
    .bind(INSTALLATION, cfg.id)
    .all<Row>()
    .then((r) => r.results);
}

function runRow(): Promise<Row | null> {
  return env.DB.prepare("SELECT state, reason, started_at, finished_at, duration_ms FROM runs WHERE run_id = 'run_a'").first<Row>();
}

describe("Telegram sink in a run's fan-out", () => {
  it("leaves the run as it finished when Telegram fails", async () => {
    tg.respond("POST", botMethod("sendMessage"), () => new Response("Bad Gateway", { status: 502 }));

    const agent = await seedAgent(INSTALLATION);
    const sock = await connect(agent);
    expect(await sock.hello()).toMatchObject({ type: "welcome" });
    const res = await agent.stub.fetch("https://do/trigger", {
      method: "POST",
      headers: { "x-hookci-agent-id": agent.agentId },
      body: JSON.stringify(TRIGGER),
    });
    expect(res.status).toBe(202);
    const { trigger_id: triggerId } = await res.json<{ trigger_id: string }>();
    expect(await sock.next()).toMatchObject({ type: "trigger", trigger_id: triggerId });
    await sock.request({ type: "accepted", trigger_id: triggerId, run_id: "run_a" });
    await sock.request({ type: "job_planned", run_id: "run_a", jobs: [{ name: "build", needs: [] }] });
    await sock.request({ type: "event", agent_seq: 1, run_id: "run_a", state: "running" });
    await sock.request({ type: "event", agent_seq: 2, run_id: "run_a", job: "build", state: "failed", duration_ms: 900, tail: ["boom"] });
    await sock.request({ type: "event", agent_seq: 3, run_id: "run_a", state: "failed", duration_ms: 1000 });

    const finished = await runRow();
    expect(finished).toMatchObject({ state: "failed", finished_at: expect.any(Number) });

    const outbox = env.SINK_OUTBOX.get(env.SINK_OUTBOX.idFromName(`${INSTALLATION}:${cfg.id}`));
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(outbox);
      expect(await deliveries()).toContainEqual({ status: "retrying", http_status: 502 });
    });

    // Past every retry delay, Telegram now rejects the token: the sink is disabled, the run untouched.
    tg.respond("POST", botMethod("sendMessage"), () => botError(401, "Unauthorized"));
    await vi.waitFor(async () => {
      testClock.advance(3_600_000);
      await runDurableObjectAlarm(outbox);
      expect(await deliveries()).toContainEqual({ status: "dropped", http_status: 401 });
    });
    expect((await getSinkConfigWithSecret(env, t, cfg.id))?.disabledReason).toBe("telegram_unauthorized");

    expect(tg.calls.some((call) => new URL(call.url).pathname.endsWith("/sendMessage"))).toBe(true);
    expect(await runRow()).toEqual(finished);
    expect(
      await runInDurableObject(agent.stub, (dob) => dob.sql.exec<{ state: string }>("SELECT state FROM triggers WHERE trigger_id = ?", triggerId).one().state),
    ).toBe("done");
  });
});
