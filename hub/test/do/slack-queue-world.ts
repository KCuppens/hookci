import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach } from "vitest";
import { encryptToken, parseEncKeys } from "../../src/crypto";
import { upsertWorkspace } from "../../src/db/workspaces";
import type { Clock } from "../../src/do/clock";
import type { SlackQueueStats } from "../../src/do/slack-outbound";
import { workspaceAad } from "../../src/slack/tokens";
import type { FakeService } from "../fakes/http";
import { createFakeSlack } from "../fakes/slack";

interface QueueWorld {
  /** A workspace seeded fresh for each test, so its DO starts with full buckets. */
  team: string;
  slack: FakeService;
  /** Stands still until advance(), unlike testClock, so exact waits can be asserted. */
  clock: Clock & { advance(ms: number): void };
}

let teams = 0;

/**
 * Seeds a workspace per test and routes its SlackWorkspaceDO to a fake Slack
 * and a frozen clock. The clock runs an hour ahead of the wall clock, so the
 * alarms the queue sets never fire on their own; call after() to run them.
 */
export function useQueueWorld(): QueueWorld {
  let at = 0;
  const world: QueueWorld = {
    team: "",
    slack: createFakeSlack(),
    clock: {
      now: () => at,
      advance(ms) {
        at += ms;
      },
    },
  };
  let saved: Pick<typeof env, "__TEST_CLOCK" | "__TEST_FETCHER">;
  beforeEach(async () => {
    world.team = `TQUEUE${++teams}`;
    const { ct, keyVersion } = await encryptToken(parseEncKeys(env.TOKEN_ENC_KEYS), "xoxb-queue", workspaceAad(world.team));
    await upsertWorkspace(env.DB, {
      team_id: world.team,
      team_name: "Queue",
      bot_user_id: "U0BOT",
      bot_token_ct: ct,
      key_version: keyVersion,
      installed_by: "U0ADMIN",
      status: "active",
      created_at: 1,
    });
    at = Date.now() + 3_600_000;
    saved = { __TEST_CLOCK: env.__TEST_CLOCK, __TEST_FETCHER: env.__TEST_FETCHER };
    env.__TEST_CLOCK = world.clock;
    env.__TEST_FETCHER = world.slack.fetcher;
  });
  afterEach(() => {
    Object.assign(env, saved);
  });
  return world;
}

export function queueStub(world: QueueWorld) {
  return env.SLACK_DO.get(env.SLACK_DO.idFromName(world.team));
}

export async function queueStats(world: QueueWorld): Promise<SlackQueueStats> {
  return (await queueStub(world).fetch("https://do/queue-stats")).json<SlackQueueStats>();
}

/** Moves the clock on by ms and runs the alarm the queue set, if any. */
export async function after(world: QueueWorld, ms: number): Promise<void> {
  world.clock.advance(ms);
  await runDurableObjectAlarm(queueStub(world));
}

/** One field of a form body the fake Slack decoded. */
export function formField(body: unknown, name: string): unknown {
  return body && typeof body === "object" && name in body ? Reflect.get(body, name) : undefined;
}
