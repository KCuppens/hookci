import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INSTALLATION, REPO } from "../commands-helpers";
import { deliver, type ForkWorld, forkPush, HEAD_SHA, outbox, type Row, runs, setUpForkWorld } from "./world";

const SENDER = "maintainer";
let world: ForkWorld;

beforeEach(async () => {
  world = await setUpForkWorld();
  await deliver("pull_request", forkPush());
});

afterEach(() => {
  world.restore();
  vi.restoreAllMocks();
});

async function requestApproval(headSha = HEAD_SHA): Promise<void> {
  const [row] = await runs();
  await deliver("check_run", {
    action: "requested_action",
    requested_action: { identifier: "approve_run" },
    check_run: { name: "zeroci", head_sha: headSha, external_id: row!.run_id, app: { id: Number(env.GITHUB_APP_ID) } },
    installation: { id: INSTALLATION },
    repository: { id: REPO.repo_id, full_name: REPO.full_name },
    sender: { id: 8080, login: SENDER },
  });
}

async function triggerFrames(): Promise<Row[]> {
  return (await outbox(world.agent)).filter((f) => f.type === "trigger");
}

describe("check_run requested_action approve_run", () => {
  it("dispatches the gated run untrusted when a write collaborator asks", async () => {
    world.roles[SENDER] = "write";
    await requestApproval();
    expect(await triggerFrames()).toEqual([expect.objectContaining({ trust: "untrusted" })]);
  });

  it("does nothing for a read collaborator and logs fork_approval_denied", async () => {
    const log = vi.spyOn(console, "log");
    world.roles[SENDER] = "read";
    await requestApproval();
    expect(await triggerFrames()).toEqual([]);
    const events = log.mock.calls.flatMap(([l]) => (typeof l === "string" && l.startsWith("{") ? [JSON.parse(l)] : []));
    expect(events).toContainEqual(expect.objectContaining({ event: "fork_approval_denied", permission: "read" }));
  });

  it("does nothing when head_sha is not the pull request head", async () => {
    world.roles[SENDER] = "write";
    await requestApproval("0000000000000000000000000000000000000000");
    expect(await triggerFrames()).toEqual([]);
    expect(await runs()).toEqual([expect.objectContaining({ state: "gated" })]);
  });
});
