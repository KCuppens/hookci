import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertInstallation } from "../../src/db/installations";
import { upsertRepos } from "../../src/db/repos";
import { tenantDb } from "../../src/db/tenant";
import { type LogRef, signLogUrl } from "../../src/logs/signing";
import { escapeHtml } from "../../src/pages/layout";
import { S } from "../../src/strings";
import { testClock } from "../clock";
import { clearTables } from "../db/helpers";
import { connect, seedAgent } from "../do/agent-socket";
import { seedRun } from "../logs/helpers";

const A = 61;
const B = 62;
const RUNNING = "run_stream_running";
const FINISHED = "run_stream_finished";
const OTHER = "run_stream_other";
const LIVE = "run_stream_live";
const RUNNING_ROW = { state: "running", finished_at: null, duration_ms: null } as const;

beforeEach(async () => {
  await clearTables();
  for (const [id, repoId] of [
    [A, 6100],
    [B, 6200],
  ] as const) {
    await upsertInstallation(env.DB, { id, account_login: `acct${id}`, account_type: "Organization", account_id: id * 10, created_at: 1 });
    await upsertRepos(tenantDb(env.DB, id), [{ repo_id: repoId, full_name: `acct${id}/repo`, default_branch: "main" }]);
  }
  await seedRun(A, 6100, RUNNING, null, "test", RUNNING_ROW);
  await seedRun(A, 6100, FINISHED, null);
  await seedRun(B, 6200, OTHER, null, "test", RUNNING_ROW);
});

async function streamUrl(ref: LogRef): Promise<string> {
  return (await signLogUrl(env, ref, new Date(testClock.now()))).replace("/logs/view?", "/logs/stream?");
}

function fetchHub(url: string): Promise<Response> {
  return exports.default.fetch(url, { encodeResponseBody: "manual" });
}

function expectEventStream(res: Response): void {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
}

async function expectLinkExpired(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect(await res.text()).toContain(escapeHtml(S.logViewer.linkExpired));
}

describe("GET /logs/stream", () => {
  it("answers 403 to a changed signature", async () => {
    const url = new URL(await streamUrl({ installationId: A, runId: RUNNING, job: "test" }));
    const sig = url.searchParams.get("sig") ?? "";
    url.searchParams.set("sig", `${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`);
    await expectLinkExpired(await fetchHub(url.toString()));
  });

  it("answers 403 to a link signed for installation A naming B's run", async () => {
    await expectLinkExpired(await fetchHub(await streamUrl({ installationId: A, runId: OTHER, job: "test" })));
  });

  it("answers 409 run_finished once the run is terminal", async () => {
    const res = await fetchHub(await streamUrl({ installationId: A, runId: FINISHED, job: "test" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "run_finished" });
  });

  it("streams offline for a running run no agent has claimed", async () => {
    const res = await fetchHub(await streamUrl({ installationId: A, runId: RUNNING, job: "test" }));
    expectEventStream(res);
    expect(await res.text()).toBe("event: offline\ndata: {}\n\n");
  });

  it("proxies the job's live log from its agent", async () => {
    const agent = await seedAgent(A);
    await seedRun(A, 6100, LIVE, agent.agentId, "test", RUNNING_ROW);
    const sock = await connect(agent);
    await sock.hello();

    const res = await fetchHub(await streamUrl({ installationId: A, runId: LIVE, job: "test" }));
    expectEventStream(res);
    expect(await sock.next()).toEqual({ v: 1, type: "log_subscribe", run_id: LIVE, job: "test", offset: 0 });

    sock.send({ v: 1, type: "log", run_id: LIVE, job: "test", offset: 0, bytes: btoa("step 1\n"), eof: true });
    expect(await res.text()).toBe('event: log\ndata: {"offset":0,"text":"step 1\\n"}\n\nevent: eof\ndata: {}\n\n');
  });

  it("unsubscribes the agent when the viewer goes away", async () => {
    const agent = await seedAgent(A);
    await seedRun(A, 6100, LIVE, agent.agentId, "test", RUNNING_ROW);
    const sock = await connect(agent);
    await sock.hello();

    const res = await fetchHub(await streamUrl({ installationId: A, runId: LIVE, job: "test" }));
    expect(await sock.next()).toMatchObject({ type: "log_subscribe", run_id: LIVE });
    await res.body?.cancel();
    expect(await sock.next()).toEqual({ v: 1, type: "log_unsubscribe", run_id: LIVE, job: "test" });
  });
});

describe("GET /logs/viewer.js", () => {
  it("serves the live-tail script under the viewer's CSP", async () => {
    const res = await fetchHub("https://hub.test/logs/viewer.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    const js = await res.text();
    expect(js).toContain("new EventSource(");
    expect(js).not.toContain("innerHTML");
  });
});
