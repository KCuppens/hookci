import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { S } from "../../src/strings";
import { LOGIN } from "../commands-helpers";
import { click, deliver, type ForkWorld, forkPush, HEAD_SHA, outbox, type Row, runs, setUpForkWorld } from "./world";

const NEW_SHA = "beefbeefbeefbeefbeefbeefbeefbeefbeefbeef";
let world: ForkWorld;

beforeEach(async () => {
  world = await setUpForkWorld();
  await deliver("pull_request", forkPush());
});

afterEach(() => world.restore());

async function gatedRunId(): Promise<string> {
  const [row] = await runs();
  return String(row!.run_id);
}

async function triggerFrames(): Promise<Row[]> {
  return (await outbox(world.agent)).filter((f) => f.type === "trigger");
}

describe("Slack Approve run button", () => {
  it("lets a linked writer approve once, dispatching exactly one untrusted trigger; a second click is already used", async () => {
    world.roles[LOGIN] = "write";
    const runId = await gatedRunId();

    expect((await click(world, "fork:approve", `${runId}:${HEAD_SHA}`)).text).toBe(S.forks.approved);
    const frames = await triggerFrames();
    expect(frames).toEqual([expect.objectContaining({ type: "trigger", trust: "untrusted" })]);

    expect((await click(world, "fork:approve", `${runId}:${HEAD_SHA}`)).text).toBe(S.forks.alreadyApproved);
    expect(await triggerFrames()).toEqual(frames);
  });

  it("refuses a user with read access", async () => {
    world.roles[LOGIN] = "read";
    expect((await click(world, "fork:approve", `${await gatedRunId()}:${HEAD_SHA}`)).text).toBe(S.forks.notAllowed);
    expect(await triggerFrames()).toEqual([]);
  });

  it("prompts an unlinked Slack user to link", async () => {
    world.roles[LOGIN] = "write";
    expect((await click(world, "fork:approve", `${await gatedRunId()}:${HEAD_SHA}`, "U0STRANGER")).text).toBe(S.slack.notLinked);
    expect(await triggerFrames()).toEqual([]);
  });

  it("answers stale for the old button after a new push supersedes the run", async () => {
    world.roles[LOGIN] = "write";
    const oldRunId = await gatedRunId();
    world.pull.headSha = NEW_SHA;
    await deliver("pull_request", forkPush(NEW_SHA));

    expect((await click(world, "fork:approve", `${oldRunId}:${HEAD_SHA}`)).text).toBe(S.forks.staleApproval);
    expect(await runs()).toEqual([
      expect.objectContaining({ run_id: oldRunId, state: "superseded" }),
      expect.objectContaining({ sha: NEW_SHA, state: "gated", reason: "fork_gated" }),
    ]);
    expect(await triggerFrames()).toEqual([]);
  });
});
