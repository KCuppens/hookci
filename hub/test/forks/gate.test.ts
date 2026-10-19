import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggregateFor } from "../../src/checks/map";
import type { RunView } from "../../src/sinks/types";
import { renderRunMessage } from "../../src/slack/messages";
import { deliver, type ForkWorld, forkPush, HEAD_SHA, outbox, POLICY_FILE, runs, setUpForkWorld } from "./world";

let world: ForkWorld;

beforeEach(async () => {
  world = await setUpForkWorld();
});

afterEach(() => world.restore());

function lastRunView(): RunView {
  const updates = world.sink.calls.flatMap((c) => (c.op === "onRunUpdate" ? [c.run] : []));
  const run = updates.at(-1);
  if (!run) throw new Error("no run update reached the sinks");
  return run;
}

function buttons(view: RunView): { action_id: string; value: string }[] {
  const blocks = renderRunMessage(view, { notify: "normal" }).blocks as { type: string; elements?: { action_id: string; value: string }[] }[];
  return blocks.flatMap((b) => (b.type === "actions" ? (b.elements ?? []) : []));
}

describe("fork pull request gate", () => {
  it("records the fork run as gated fork_gated, sends the agent nothing and offers Approve in Slack and on the check", async () => {
    await deliver("pull_request", forkPush());

    const [row] = await runs();
    expect(row).toMatchObject({ state: "gated", reason: "fork_gated", sha: HEAD_SHA });
    expect((await outbox(world.agent)).filter((f) => f.type === "trigger")).toEqual([]);
    const view = lastRunView();
    expect(view).toMatchObject({ state: "gated", reason: "fork_gated" });
    expect(buttons(view)).toEqual([expect.objectContaining({ action_id: "fork:approve", value: `${row!.run_id}:${HEAD_SHA}` })]);
    expect(aggregateFor(view, "https://hub.test")).toMatchObject({
      conclusion: "action_required",
      actions: [expect.objectContaining({ identifier: "approve_run" })],
    });
  });

  it("with forks: never gates as fork_never with no Approve button and no check action", async () => {
    world.files[POLICY_FILE] = "forks: never\n";
    await deliver("pull_request", forkPush());

    expect(await runs()).toEqual([expect.objectContaining({ state: "gated", reason: "fork_never" })]);
    expect((await outbox(world.agent)).filter((f) => f.type === "trigger")).toEqual([]);
    const view = lastRunView();
    expect(buttons(view)).toEqual([]);
    const check = aggregateFor(view, "https://hub.test");
    expect(check).toMatchObject({ status: "completed", conclusion: "action_required" });
    expect("actions" in check).toBe(false);
  });
});
