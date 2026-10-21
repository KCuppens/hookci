import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadForkPolicy } from "../../src/forks/policy";
import { GitHubClient } from "../../src/github/client";
import { testClock } from "../clock";
import { INSTALLATION, REPO } from "../commands-helpers";
import { BASE_SHA, deliver, type ForkWorld, forkPush, HEAD_SHA, POLICY_FILE, setUpForkWorld } from "./world";

let world: ForkWorld;

beforeEach(async () => {
  world = await setUpForkWorld();
});

afterEach(() => {
  world.restore();
  vi.restoreAllMocks();
});

async function policyAtBase() {
  const gh = await new GitHubClient(env, env.__TEST_FETCHER!, () => testClock.now()).installation(INSTALLATION);
  return loadForkPolicy(gh, REPO.full_name, BASE_SHA);
}

describe("loadForkPolicy", () => {
  it("returns never when the base ref says forks: never", async () => {
    world.files[POLICY_FILE] = "forks: never\n";
    expect(await policyAtBase()).toEqual({ policy: "never", trustAllRefused: false });
  });

  it("refuses trust: all, logging trust_all_refused, and still gates", async () => {
    const log = vi.spyOn(console, "log");
    world.files[POLICY_FILE] = "trust: all\n";
    expect(await policyAtBase()).toEqual({ policy: "approve", trustAllRefused: true });
    expect(log.mock.calls.map(([l]) => JSON.parse(String(l)))).toContainEqual(expect.objectContaining({ event: "trust_all_refused", repo: REPO.full_name }));
  });

  it("returns approve when the base ref has no .hookci.yml", async () => {
    expect(await policyAtBase()).toEqual({ policy: "approve", trustAllRefused: false });
  });

  it("reads only the base SHA for a fork delivery, never the fork head", async () => {
    world.files[`${REPO.full_name}@${HEAD_SHA}:.hookci.yml`] = "forks: approve\n";
    await deliver("pull_request", forkPush());
    expect(world.refs).toEqual([BASE_SHA]);
  });
});
