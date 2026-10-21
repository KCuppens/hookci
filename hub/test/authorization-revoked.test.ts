import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hex, hmacSha256 } from "../src/crypto";
import worker from "../src/index";
import { registerRevokeHook } from "../src/webhook/authorization";
import { clearTables } from "./db/helpers";

const hookCalls: { first: number[]; second: number[] } = { first: [], second: [] };
registerRevokeHook(async (_env, githubUserId) => {
  hookCalls.first.push(githubUserId);
});
registerRevokeHook(async (_env, githubUserId) => {
  hookCalls.second.push(githubUserId);
});

beforeEach(async () => {
  await clearTables();
  hookCalls.first = [];
  hookCalls.second = [];
  const links: [string, string, number, string][] = [
    ["T0ACME", "U0OCTO", 42, "octocat"],
    ["T0UMBRELLA", "U0OCTO2", 42, "octocat"],
    ["T0ACME", "U0HUBOT", 43, "hubot"],
  ];
  for (const [team, user, githubId, login] of links) {
    await env.DB.prepare("INSERT INTO user_links (team_id, slack_user_id, github_user_id, github_login, created_at) VALUES (?1, ?2, ?3, ?4, 1)")
      .bind(team, user, githubId, login)
      .run();
  }
});

/** Delivers a signed github_app_authorization webhook and returns the deliveries row's status and note. */
async function deliver(body: unknown): Promise<unknown> {
  const id = crypto.randomUUID();
  const raw = JSON.stringify(body);
  const headers = new Headers({
    "content-type": "application/json",
    "x-github-event": "github_app_authorization",
    "x-github-delivery": id,
    "x-hub-signature-256": `sha256=${hex(await hmacSha256(env.GITHUB_WEBHOOK_SECRET, raw))}`,
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request("https://hub.test/github/webhook", { method: "POST", headers, body: raw }), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(202);
  return env.DB.prepare("SELECT status, note FROM deliveries WHERE delivery_id = ?1").bind(id).first();
}

async function userLinks(): Promise<unknown[]> {
  return (await env.DB.prepare("SELECT team_id, slack_user_id, github_user_id FROM user_links ORDER BY team_id, slack_user_id").all()).results;
}

describe("github_app_authorization webhook", () => {
  it("on revoked, deletes the user's links in every team, keeps others, and runs every revoke hook", async () => {
    expect(await deliver({ action: "revoked", sender: { id: 42, login: "octocat" } })).toEqual({ status: "processed", note: null });
    expect(await userLinks()).toEqual([{ team_id: "T0ACME", slack_user_id: "U0HUBOT", github_user_id: 43 }]);
    expect(hookCalls).toEqual({ first: [42], second: [42] });
  });

  it("drops a payload without a numeric sender id and changes nothing", async () => {
    expect(await deliver({ action: "revoked", sender: { login: "octocat" } })).toEqual({ status: "dropped", note: "malformed_payload" });
    expect(await userLinks()).toHaveLength(3);
    expect(hookCalls).toEqual({ first: [], second: [] });
  });
});
