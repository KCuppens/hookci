import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { S } from "../../src/strings";
import { LOGIN, REPO, zeroci } from "../commands-helpers";
import { click, deliver, type ForkWorld, forkPush, HEAD_SHA, outbox, POLICY_FILE, type Row, runs, setUpForkWorld } from "./world";

const SHORT_SHA = HEAD_SHA.slice(0, 7);
let world: ForkWorld;

beforeEach(async () => {
  world = await setUpForkWorld();
  world.roles[LOGIN] = "write";
  await deliver("pull_request", forkPush());
  const [gated] = await runs();
  expect((await click(world, "fork:approve", `${gated!.run_id}:${HEAD_SHA}`)).text).toBe(S.forks.approved);
});

afterEach(() => world.restore());

/** Trigger frames the AgentDO queued for the retried attempt. */
async function retryFrames(): Promise<Row[]> {
  return (await outbox(world.agent)).filter((f) => f.type === "trigger" && f.attempt === 2);
}

describe("/zeroci retry of a fork pull request run", () => {
  it("gates the new attempt until a writer approves it, then dispatches it once as untrusted", async () => {
    expect((await zeroci(world, `retry ${REPO.full_name}`)).text).toBe(S.slack.retryGated(REPO.full_name, SHORT_SHA, 2));
    expect(await retryFrames()).toEqual([]);
    const retried = (await runs()).at(-1)!;
    expect(retried).toMatchObject({ attempt: 2, sha: HEAD_SHA, state: "gated", reason: "fork_gated" });

    expect((await click(world, "fork:approve", `${retried.run_id}:${HEAD_SHA}`)).text).toBe(S.forks.approved);
    const frames = await retryFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ trust: "untrusted", sha: HEAD_SHA });
    expect((await click(world, "fork:approve", `${retried.run_id}:${HEAD_SHA}`)).text).toBe(S.forks.alreadyApproved);
    expect(await retryFrames()).toHaveLength(1);
  });

  it("never runs the retry when the base ref sets forks: never", async () => {
    world.files[POLICY_FILE] = "checks:\n  forks: never\n";

    expect((await zeroci(world, `retry ${REPO.full_name}`)).text).toBe(S.slack.retryForkNever(REPO.full_name, SHORT_SHA));
    expect(await retryFrames()).toEqual([]);
    expect((await runs()).at(-1)).toMatchObject({ attempt: 2, state: "gated", reason: "fork_never" });
  });

  it("dispatches the retry at once, as untrusted, when a self-hosted hub honors the base ref's trust: all", async () => {
    const saved = env.HUB_MODE;
    env.HUB_MODE = "self_hosted";
    try {
      world.files[POLICY_FILE] = "checks:\n  trust: all\n";
      await zeroci(world, `retry ${REPO.full_name}`);
      expect(await retryFrames()).toEqual([expect.objectContaining({ trust: "untrusted", sha: HEAD_SHA })]);
      expect((await runs()).at(-1)).toMatchObject({ attempt: 2, state: "queued" });
    } finally {
      env.HUB_MODE = saved;
    }
  });
});
