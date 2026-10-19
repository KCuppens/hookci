import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hex, hmacSha256 } from "../src/crypto";
import { markDeleted } from "../src/db/installations";
import type { Repository } from "../src/github/types";
import worker from "../src/index";
import { testClock } from "./clock";
import { clearTables } from "./db/helpers";
import { createFakeGitHub } from "./fakes/github";
import { generateAppKey } from "./github/helpers";

const INSTALLATION = 4242;
const PERMISSIONS = { contents: "read", metadata: "read", checks: "write" };

function repo(id: number, name: string): Repository {
  return { id, name, full_name: `acme/${name}`, private: true, default_branch: "main", archived: false, owner: { id: 9, login: "acme", type: "Organization" } };
}

function payload(action: string, permissions: Record<string, string> = PERMISSIONS) {
  return {
    action,
    installation: {
      id: INSTALLATION,
      app_id: Number(env.GITHUB_APP_ID),
      account: { id: 9, login: "acme", type: "Organization" },
      target_id: 9,
      target_type: "Organization",
      permissions,
      suspended_at: null,
    },
    sender: { id: 7001, login: "octocat" },
  };
}

/** Delivers a signed webhook, waits for its handler, and returns the delivery id. */
async function deliver(event: string, body: unknown): Promise<string> {
  const id = crypto.randomUUID();
  const raw = JSON.stringify(body);
  const headers = new Headers({
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": id,
    "x-hub-signature-256": `sha256=${hex(await hmacSha256(env.GITHUB_WEBHOOK_SECRET, raw))}`,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://hub.test/github/webhook", { method: "POST", headers, body: raw }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(202);
  return id;
}

type StoredInstallation = { id: number; account_login: string; permissions: string; deleted_at: number | null; purge_after: number | null };

async function installations(): Promise<StoredInstallation[]> {
  const { results } = await env.DB.prepare("SELECT id, account_login, permissions, deleted_at, purge_after FROM installations").all<StoredInstallation>();
  return results;
}

async function repoNames(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT full_name FROM repos WHERE installation_id = ?1 ORDER BY full_name").bind(INSTALLATION).all<{ full_name: string }>();
  return results.map((r) => r.full_name);
}

let repositories: Repository[];
const restore: (() => void)[] = [];

beforeEach(async () => {
  await clearTables();
  repositories = [repo(1, "widgets"), repo(2, "gadgets")];
  const gh = createFakeGitHub();
  gh.respond("POST", "/app/installations/:id/access_tokens", () =>
    Response.json({ token: "ghs_installation", expires_at: new Date(testClock.now() + 3_600_000).toISOString() }, { status: 201 }),
  );
  gh.respond("GET", "/installation/repositories", () => Response.json({ total_count: repositories.length, repositories }));
  const saved = { fetcher: env.__TEST_FETCHER, key: env.GITHUB_APP_PRIVATE_KEY };
  env.__TEST_FETCHER = gh.fetcher;
  env.GITHUB_APP_PRIVATE_KEY = (await generateAppKey()).pem;
  restore.push(() => {
    env.__TEST_FETCHER = saved.fetcher;
    env.GITHUB_APP_PRIVATE_KEY = saved.key;
  });
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

describe("installation webhook", () => {
  it("created twice leaves one installation row and its current repos", async () => {
    await deliver("installation", payload("created"));
    await deliver("installation", payload("created"));
    expect(await installations()).toEqual([
      { id: INSTALLATION, account_login: "acme", permissions: JSON.stringify(PERMISSIONS), deleted_at: null, purge_after: null },
    ]);
    expect(await repoNames()).toEqual(["acme/gadgets", "acme/widgets"]);

    repositories = [repo(2, "gadgets"), repo(3, "sprockets")];
    await deliver("installation", payload("created"));
    expect(await repoNames()).toEqual(["acme/gadgets", "acme/sprockets"]);
  });

  it("a reinstall within the purge window clears deleted_at and purge_after", async () => {
    await deliver("installation", payload("created"));
    await markDeleted(env.DB, INSTALLATION, testClock.now(), testClock.now() + 86_400_000);
    await deliver("installation", payload("created"));
    expect(await installations()).toEqual([expect.objectContaining({ deleted_at: null, purge_after: null })]);
  });

  it("new_permissions_accepted stores the new permissions", async () => {
    await deliver("installation", payload("created"));
    const granted = { ...PERMISSIONS, pull_requests: "read" };
    await deliver("installation", payload("new_permissions_accepted", granted));
    expect(await installations()).toEqual([expect.objectContaining({ permissions: JSON.stringify(granted) })]);
  });

  it("drops a payload without a usable installation", async () => {
    const id = await deliver("installation", { action: "created", installation: { id: INSTALLATION } });
    expect(await env.DB.prepare("SELECT status, note FROM deliveries WHERE delivery_id = ?1").bind(id).first()).toEqual({
      status: "dropped",
      note: "malformed_payload",
    });
    expect(await installations()).toEqual([]);
  });
});
