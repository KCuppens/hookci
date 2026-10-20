import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isNoreplyEmail, resolveAuthor } from "../../src/slack/authors";
import { clearTables } from "../db/helpers";
import { formField, useQueueWorld } from "../do/slack-queue-world";

const INSTALLATION = 91;
const HOUR = 60 * 60 * 1000;
const EMAIL = "alice@acme.test";

/** Tables are cleared before the queue world seeds its workspace. */
beforeEach(clearTables);
const world = useQueueWorld();

function lookups(): string[] {
  return world.slack.calls.filter((call) => call.url.endsWith("/api/users.lookupByEmail")).map((call) => String(formField(call.body, "email")));
}

function lookupAnswers(user: string | null): void {
  world.slack.respond("POST", "/api/users.lookupByEmail", () =>
    Response.json(user ? { ok: true, user: { id: user } } : { ok: false, error: "users_not_found" }),
  );
}

describe("resolveAuthor", () => {
  beforeEach(() => lookupAnswers(null));

  it("takes the author_map row over the email lookup", async () => {
    lookupAnswers("U0EMAIL");
    await env.DB.prepare("INSERT INTO author_map (installation_id, team_id, github_login, slack_user_id) VALUES (?1, ?2, 'alice', 'U0MAP')")
      .bind(INSTALLATION, world.team)
      .run();
    expect(await resolveAuthor(env, INSTALLATION, world.team, { login: "alice", email: EMAIL })).toBe("U0MAP");
    expect(lookups()).toEqual([]);
  });

  it("never looks up a GitHub noreply address", async () => {
    for (const email of ["12345+alice@users.noreply.github.com", "noreply@github.com"]) {
      expect(isNoreplyEmail(email)).toBe(true);
      expect(await resolveAuthor(env, INSTALLATION, world.team, { login: "alice", email })).toBeNull();
    }
    expect(lookups()).toEqual([]);
  });

  it("caches a miss for 24 hours, then looks up again", async () => {
    expect(await resolveAuthor(env, INSTALLATION, world.team, { login: "alice", email: EMAIL })).toBeNull();
    expect(lookups()).toEqual([EMAIL]);

    world.clock.advance(23 * HOUR);
    expect(await resolveAuthor(env, INSTALLATION, world.team, { login: "alice", email: EMAIL })).toBeNull();
    expect(lookups()).toEqual([EMAIL]);

    lookupAnswers("U0ALICE");
    world.clock.advance(2 * HOUR);
    expect(await resolveAuthor(env, INSTALLATION, world.team, { login: "alice", email: EMAIL })).toBe("U0ALICE");
    expect(lookups()).toEqual([EMAIL, EMAIL]);
  });

  it("finds a hit by login on updates that carry no email", async () => {
    lookupAnswers("U0ALICE");
    expect(await resolveAuthor(env, INSTALLATION, world.team, { login: "alice", email: EMAIL })).toBe("U0ALICE");
    expect(await resolveAuthor(env, INSTALLATION, world.team, { login: "alice" })).toBe("U0ALICE");
    expect(await resolveAuthor(env, INSTALLATION, world.team, { login: "bob" })).toBeNull();
    expect(lookups()).toEqual([EMAIL]);
  });

  it("never stores the raw email in the cache key", async () => {
    lookupAnswers("U0ALICE");
    await resolveAuthor(env, INSTALLATION, world.team, { login: "alice", email: EMAIL });
    lookupAnswers(null);
    await resolveAuthor(env, INSTALLATION, world.team, { login: "carol", email: "Carol@Acme.test" });

    const { results } = await env.DB.prepare("SELECT key FROM author_cache WHERE installation_id = ?1 ORDER BY key").bind(INSTALLATION).all<{ key: string }>();
    const keys = results.map((row) => row.key);
    expect(keys).toHaveLength(3);
    expect(keys.filter((key) => key.startsWith("email:"))).toHaveLength(2);
    for (const key of keys) expect(key.toLowerCase()).not.toMatch(/@|alice@|carol@|acme\.test/);
  });
});
