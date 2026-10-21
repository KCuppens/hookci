import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertUser, linkGithub, replaceEmailToken } from "../src/db/accounts";
import { purgeExpired } from "../src/db/purge";
import { collectUserData } from "../src/identity/export";
import { S } from "../src/strings";
import { testClock } from "./clock";
import { type CommandWorld, hookci, LOGIN, setUpCommandWorld, TEAM, USER } from "./commands-helpers";
import { clearTables } from "./db/helpers";

const DAY = 86_400_000;
const GITHUB_ID = 7001;
const OTHER_GITHUB_ID = 7002;
const HASH = "pbkdf2-sha256$v1$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function seedAccount(id: string, email: string, options: { github?: [number, string]; verified?: boolean; createdAt?: number } = {}): Promise<void> {
  const createdAt = options.createdAt ?? testClock.now();
  await insertUser(env.DB, {
    id,
    email,
    emailNorm: email.toLowerCase(),
    passwordHash: HASH,
    verifiedAt: options.verified === false ? null : createdAt,
    googleSub: null,
    createdAt,
  });
  if (options.github) await linkGithub(env.DB, id, options.github[0], options.github[1]);
}

async function count(table: string): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1;
}

const ALICE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BOB_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

describe("export and delete-my-data", () => {
  let world: CommandWorld;

  beforeEach(async () => {
    world = await setUpCommandWorld();
  });

  afterEach(() => {
    world.restore();
  });

  it("includes the account of the linked GitHub user, without the hash or any token", async () => {
    await seedAccount(ALICE_ID, "Alice@Example.test", { github: [GITHUB_ID, LOGIN] });
    await replaceEmailToken(env.DB, ALICE_ID, "reset", "a".repeat(64), testClock.now(), 3_600_000);

    const data = await collectUserData(env, TEAM, USER, testClock.now());

    expect(data.account).toEqual({
      email: "Alice@Example.test",
      created_at: expect.any(Number),
      email_verified: true,
      has_password: true,
      google_linked: false,
      github_login: LOGIN,
    });
    const json = JSON.stringify(data);
    expect(json).not.toContain("pbkdf2");
    expect(json).not.toContain("a".repeat(64));
  });

  it("is null when the GitHub user has no account, and never shows another person's account", async () => {
    await seedAccount(BOB_ID, "bob@example.test", { github: [OTHER_GITHUB_ID, "hubot"] });
    expect((await collectUserData(env, TEAM, USER, testClock.now())).account).toBeNull();
  });

  it("is served by /v1/export", async () => {
    await seedAccount(ALICE_ID, "alice@example.test", { github: [GITHUB_ID, LOGIN] });
    const reply = await hookci(world, "export");
    const url = /"url":"([^"]+)"/.exec(JSON.stringify(reply.blocks))?.[1] ?? "";
    const res = await exports.default.fetch(url);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ account: { email: "alice@example.test", github_login: LOGIN } });
  });

  it("deletes the linked account and its tokens with the Slack data, and nobody else's", async () => {
    await seedAccount(ALICE_ID, "alice@example.test", { github: [GITHUB_ID, LOGIN] });
    await seedAccount(BOB_ID, "bob@example.test", { github: [OTHER_GITHUB_ID, "hubot"] });
    await replaceEmailToken(env.DB, ALICE_ID, "reset", "a".repeat(64), testClock.now(), 3_600_000);
    await replaceEmailToken(env.DB, BOB_ID, "reset", "b".repeat(64), testClock.now(), 3_600_000);

    const reply = await hookci(world, "delete-my-data");

    expect(reply.text).toBe(S.slack.deletedData(1, 0, 0, 1));
    const left = await env.DB.prepare("SELECT id FROM users").all<{ id: string }>();
    expect(left.results).toEqual([{ id: BOB_ID }]);
    const tokens = await env.DB.prepare("SELECT user_id FROM email_tokens").all<{ user_id: string }>();
    expect(tokens.results).toEqual([{ user_id: BOB_ID }]);
  });
});

describe("purgeExpired and accounts", () => {
  const NOW = 1_767_225_600_000;

  beforeEach(clearTables);

  it("drops unverified accounts after a week and keeps verified ones", async () => {
    await seedAccount("01ARZ3NDEKTSV4RRFFQ69G5FA1", "old-unverified@example.test", { verified: false, createdAt: NOW - 7 * DAY - 1 });
    await seedAccount("01ARZ3NDEKTSV4RRFFQ69G5FA2", "new-unverified@example.test", { verified: false, createdAt: NOW - 6 * DAY });
    await seedAccount("01ARZ3NDEKTSV4RRFFQ69G5FA3", "old-verified@example.test", { createdAt: NOW - 400 * DAY });

    await purgeExpired(env.DB, NOW);

    const left = await env.DB.prepare("SELECT email_norm FROM users ORDER BY email_norm").all<{ email_norm: string }>();
    expect(left.results.map((r) => r.email_norm)).toEqual(["new-unverified@example.test", "old-verified@example.test"]);
  });

  it("drops expired email tokens and keeps live ones", async () => {
    await seedAccount(ALICE_ID, "alice@example.test");
    await replaceEmailToken(env.DB, ALICE_ID, "verify", "a".repeat(64), NOW - 2 * DAY, DAY);
    await replaceEmailToken(env.DB, ALICE_ID, "reset", "b".repeat(64), NOW, 3_600_000);

    await purgeExpired(env.DB, NOW);

    const left = await env.DB.prepare("SELECT token_hash FROM email_tokens").all<{ token_hash: string }>();
    expect(left.results).toEqual([{ token_hash: "b".repeat(64) }]);
  });

  it("drops stale failed-sign-in counters", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO login_attempts (email_hash, failures, last_failure_at, locked_until) VALUES (?1, 3, ?2, 0)").bind("a".repeat(64), NOW - 2 * 3_600_000),
      env.DB.prepare("INSERT INTO login_attempts (email_hash, failures, last_failure_at, locked_until) VALUES (?1, 3, ?2, 0)").bind("b".repeat(64), NOW - 60_000),
    ]);

    await purgeExpired(env.DB, NOW);

    expect(await count("login_attempts")).toBe(1);
  });
});
