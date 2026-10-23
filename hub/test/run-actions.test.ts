import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { csrfForForm } from "../src/accounts/csrf";
import { availableRunActions } from "../src/dashboard/run-actions";
import { issueSession } from "../src/oauth/state";
import { escapeHtml } from "../src/pages/layout";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { INSTALLATION, LOGIN, OTHER_INSTALLATION } from "./commands-helpers";
import { deliver, type ForkWorld, forkPush, HEAD_SHA, outbox, type Row, runs, setUpForkWorld } from "./forks/world";

const ORIGIN = "https://hub.test";
let world: ForkWorld;

beforeEach(async () => {
  world = await setUpForkWorld();
  world.roles[LOGIN] = "write";
  await deliver("pull_request", forkPush());
});

afterEach(() => world.restore());

async function sessionFor(installationIds: number[]): Promise<string> {
  const setCookie = await issueSession(env, { installationIds, githubUserId: 7001, githubLogin: LOGIN }, testClock.now());
  return setCookie.split(";")[0] ?? "";
}

interface PostOptions {
  installationId?: number;
  session?: string | null;
  origin?: string | null;
  fetchSite?: string;
  csrf?: "valid" | "wrong" | "none";
}

/** POSTs the action's form as a browser would: session and csrf cookies, a csrf field, the hub's Origin. */
async function post(runId: string, action: string, options: PostOptions = {}): Promise<Response> {
  const { token, cookie } = await csrfForForm(env, null);
  const cookies = [options.session === undefined ? await sessionFor([INSTALLATION]) : options.session, cookie?.split(";")[0] ?? null].filter((c) => c !== null);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", cookie: cookies.join("; ") };
  if (options.origin !== null) headers.origin = options.origin ?? env.HUB_ORIGIN;
  if (options.fetchSite !== undefined) headers["sec-fetch-site"] = options.fetchSite;
  const csrf = options.csrf ?? "valid";
  const body = csrf === "none" ? "" : new URLSearchParams({ csrf: csrf === "valid" ? token : `${token}x` }).toString();
  return exports.default.fetch(`${ORIGIN}/app/${options.installationId ?? INSTALLATION}/runs/${runId}/${action}`, { method: "POST", headers, body, redirect: "manual" });
}

async function onlyRun(): Promise<Row> {
  const all = await runs();
  expect(all).toHaveLength(1);
  return all[0]!;
}

async function triggerFrames(): Promise<Row[]> {
  return (await outbox(world.agent)).filter((f) => f.type === "trigger");
}

function location(runId: string, notice: string): string {
  return `/app/${INSTALLATION}/runs/${runId}?notice=${notice}`;
}

describe("availableRunActions", () => {
  const base = { state: "success", reason: null, pr_number: null, agent_id: null };

  it("offers Approve only to a fork run waiting for approval", () => {
    expect(availableRunActions({ ...base, state: "gated", reason: "fork_gated", pr_number: 9, agent_id: "agt_1" })).toEqual({ approve: true, cancel: true, retry: false });
    expect(availableRunActions({ ...base, state: "gated", reason: "fork_gated", pr_number: 9, agent_id: null }).approve).toBe(false);
    expect(availableRunActions({ ...base, state: "running" }).approve).toBe(false);
  });

  it("offers Cancel to unfinished runs that can run, Retry to finished ones", () => {
    expect(availableRunActions({ ...base, state: "running" })).toEqual({ approve: false, cancel: true, retry: false });
    expect(availableRunActions({ ...base, state: "gated", reason: "fork_never" })).toEqual({ approve: false, cancel: false, retry: false });
    for (const state of ["success", "failed", "cancelled", "skipped", "interrupted", "superseded"]) {
      expect(availableRunActions({ ...base, state })).toEqual({ approve: false, cancel: false, retry: true });
    }
  });
});

describe("POST /app/:installationId/runs/:runId/approve", () => {
  it("lets a writer approve once, dispatching one untrusted trigger, then refuses a repeat with 409", async () => {
    const { run_id: runId } = await onlyRun();
    const res = await post(String(runId), "approve");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(location(String(runId), "approved"));
    expect(await triggerFrames()).toEqual([expect.objectContaining({ type: "trigger", trust: "untrusted", sha: HEAD_SHA })]);

    const again = await post(String(runId), "approve");
    expect(again.status).toBe(409);
    expect(await again.text()).toContain(escapeHtml(S.forks.notGated));
    expect(await triggerFrames()).toHaveLength(1);
  });

  it("refuses a user with read access, changing nothing", async () => {
    world.roles[LOGIN] = "read";
    const { run_id: runId } = await onlyRun();
    const res = await post(String(runId), "approve");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(escapeHtml(S.runActions.notAllowed));
    expect(await triggerFrames()).toEqual([]);
    expect(await onlyRun()).toMatchObject({ state: "gated" });
  });
});

describe("POST /app/:installationId/runs/:runId/cancel", () => {
  it("cancels a run waiting for approval and then refuses a second cancel with 409", async () => {
    const { run_id: runId } = await onlyRun();
    const res = await post(String(runId), "cancel");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(location(String(runId), "cancelled"));
    expect(await onlyRun()).toMatchObject({ state: "cancelled", reason: "cancelled" });
    expect(Number((await onlyRun()).finished_at)).toBeGreaterThan(0);

    const again = await post(String(runId), "cancel");
    expect(again.status).toBe(409);
    expect(await again.text()).toContain(escapeHtml(S.runActions.notCancellable));
  });

  it("accepts the Origin: null a browser sends from the no-referrer run page when the fetch is same-origin", async () => {
    const { run_id: runId } = await onlyRun();
    const res = await post(String(runId), "cancel", { origin: "null", fetchSite: "same-origin" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(location(String(runId), "cancelled"));
  });

  it("cancels a run whose agent never took it and is offline, so the approval can no longer start it", async () => {
    const { run_id: runId } = await onlyRun();
    expect((await post(String(runId), "approve")).status).toBe(303);
    const res = await post(String(runId), "cancel");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(location(String(runId), "cancelled"));
    expect(await onlyRun()).toMatchObject({ state: "cancelled" });
  });
});

describe("POST /app/:installationId/runs/:runId/retry", () => {
  it("refuses to retry a run that has not finished", async () => {
    const { run_id: runId } = await onlyRun();
    const res = await post(String(runId), "retry");
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(escapeHtml(S.runActions.notRetryable));
    expect(await runs()).toHaveLength(1);
  });

  it("retries a finished fork run as a gated second attempt, once", async () => {
    const { run_id: runId } = await onlyRun();
    expect((await post(String(runId), "cancel")).status).toBe(303);

    const res = await post(String(runId), "retry");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(location(String(runId), "retryGated"));
    expect((await runs()).at(-1)).toMatchObject({ attempt: 2, sha: HEAD_SHA, state: "gated", reason: "fork_gated" });

    const again = await post(String(runId), "retry");
    expect(again.status).toBe(303);
    expect(await runs()).toHaveLength(2);
  });
});

describe("refusals", () => {
  async function untouched(res: Response, status: number): Promise<void> {
    expect(res.status).toBe(status);
    expect(await onlyRun()).toMatchObject({ state: "gated" });
    expect(await triggerFrames()).toEqual([]);
  }

  it.each(["approve", "cancel", "retry"])("%s without a session is the dashboard's not-found page", async (action) => {
    const { run_id: runId } = await onlyRun();
    const res = await post(String(runId), action, { session: null });
    expect(await res.text()).toContain(escapeHtml(S.dashboard.notFoundTitle));
    await untouched(res, 404);
  });

  it.each(["approve", "cancel", "retry"])("%s with a session for another installation is not found and changes nothing", async (action) => {
    const { run_id: runId } = await onlyRun();
    await untouched(await post(String(runId), action, { session: await sessionFor([OTHER_INSTALLATION]) }), 404);
  });

  it.each(["approve", "cancel", "retry"])("%s of another installation's run through one's own installation is not found", async (action) => {
    const { run_id: runId } = await onlyRun();
    const res = await post(String(runId), action, { installationId: OTHER_INSTALLATION, session: await sessionFor([INSTALLATION, OTHER_INSTALLATION]) });
    await untouched(res, 404);
  });

  it.each(["approve", "cancel", "retry"])("%s without a csrf token is refused", async (action) => {
    const { run_id: runId } = await onlyRun();
    const res = await post(String(runId), action, { csrf: "none" });
    expect(await res.text()).toContain(escapeHtml(S.runActions.csrf));
    await untouched(res, 403);
  });

  it.each(["approve", "cancel", "retry"])("%s with a wrong csrf token is refused", async (action) => {
    const { run_id: runId } = await onlyRun();
    await untouched(await post(String(runId), action, { csrf: "wrong" }), 403);
  });

  it.each(["approve", "cancel", "retry"])("%s from another origin is refused", async (action) => {
    const { run_id: runId } = await onlyRun();
    await untouched(await post(String(runId), action, { origin: "https://evil.test" }), 403);
  });

  it.each(["cross-site", "same-site", "none"])("cancel with Origin: null and Sec-Fetch-Site %s is refused", async (site) => {
    const { run_id: runId } = await onlyRun();
    await untouched(await post(String(runId), "cancel", { origin: "null", fetchSite: site }), 403);
  });

  it.each(["approve", "cancel", "retry"])("%s of an unknown run is not found", async (action) => {
    await untouched(await post("no_such_run", action), 404);
  });
});
