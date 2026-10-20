import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bind } from "../../src/db/bindings";
import { tenantDb } from "../../src/db/tenant";
import { effectiveTrust, fetchBaseConfig, hubMode, readBaseConfig } from "../../src/policy/trust";
import { INSTALLATION, REPO } from "../commands-helpers";
import { BASE_SHA, type ForkWorld, HEAD_SHA, POLICY_FILE, setUpForkWorld } from "../forks/world";

let world: ForkWorld;

beforeEach(async () => {
  world = await setUpForkWorld();
});

afterEach(() => world.restore());

const selfHosted = { ...env, HUB_MODE: "self_hosted" };

describe("hubMode", () => {
  it("is shared unless HUB_MODE is exactly self_hosted", () => {
    expect(hubMode({ ...env, HUB_MODE: undefined })).toBe("shared");
    expect(hubMode({ ...env, HUB_MODE: "shared" })).toBe("shared");
    expect(hubMode({ ...env, HUB_MODE: "weird" })).toBe("shared");
    expect(hubMode({ ...env, HUB_MODE: "Self_Hosted" })).toBe("shared");
    expect(hubMode(selfHosted)).toBe("self_hosted");
  });
});

describe("effectiveTrust", () => {
  const t = () => tenantDb(env.DB, INSTALLATION);

  it("keeps collaborators as declared in either mode", async () => {
    expect(await effectiveTrust({ ...env, HUB_MODE: "shared" }, t(), REPO.repo_id, "collaborators")).toEqual({
      declared: "collaborators",
      effective: "collaborators",
      refused: null,
    });
    expect(await effectiveTrust(selfHosted, t(), REPO.repo_id, "collaborators")).toMatchObject({ effective: "collaborators", refused: null });
  });

  it("refuses trust: all on the shared hub, and when HUB_MODE is unset or unknown", async () => {
    for (const mode of ["shared", undefined, "weird"]) {
      expect(await effectiveTrust({ ...env, HUB_MODE: mode }, t(), REPO.repo_id, "all")).toEqual({
        declared: "all",
        effective: "collaborators",
        refused: "shared_hub",
      });
    }
  });

  it("refuses trust: all on a self-hosted hub when the repo has a deploy binding", async () => {
    await bind(t(), REPO.repo_id, "deploy:production", world.agent.agentId);
    expect(await effectiveTrust(selfHosted, t(), REPO.repo_id, "all")).toEqual({ declared: "all", effective: "collaborators", refused: "deploy_bindings" });
  });

  it("honors trust: all on a self-hosted hub when the repo only has a checks binding", async () => {
    expect(await effectiveTrust(selfHosted, t(), REPO.repo_id, "all")).toEqual({ declared: "all", effective: "all", refused: null });
  });
});

describe("fetchBaseConfig", () => {
  const atBase = () => fetchBaseConfig(env, INSTALLATION, REPO.full_name, BASE_SHA);

  it("reads checks.trust and checks.forks at the base ref only", async () => {
    world.files[POLICY_FILE] = "checks:\n  trust: all\n  forks: never\n";
    world.files[`${REPO.full_name}@${HEAD_SHA}:.zeroci.yml`] = "checks:\n  trust: collaborators\n";
    expect(await atBase()).toEqual({ trust: "all", forks: "never" });
    expect(world.refs).toEqual([BASE_SHA]);
  });

  it("defaults to collaborators and gated when the base ref has no .zeroci.yml", async () => {
    expect(await atBase()).toEqual({ trust: "collaborators", forks: "gated" });
  });

  it("defaults when the file does not parse", async () => {
    world.files[POLICY_FILE] = "checks: [trust: all\n";
    expect(await atBase()).toEqual({ trust: "collaborators", forks: "gated" });
  });

  it("defaults each unknown value on its own and ignores top-level keys", async () => {
    world.files[POLICY_FILE] = "checks:\n  trust: approve\n  forks: never\n";
    expect(await atBase()).toEqual({ trust: "collaborators", forks: "never" });
    world.files[POLICY_FILE] = "trust: all\nforks: never\n";
    expect(await atBase()).toEqual({ trust: "collaborators", forks: "gated" });
  });
});

describe("readBaseConfig", () => {
  const defaults = { trust: "collaborators", forks: "gated" };

  it("reads nested values with comments, quotes and other keys around them", () => {
    const text = [
      "# zeroci",
      "version: 1",
      "checks:  # who runs",
      "",
      "    # trust: collaborators",
      "    trust: \"all\"   # self-hosted only",
      "    jobs:",
      "      test:",
      "        run: |",
      "          forks: gated",
      "    forks: 'never'",
      "deployments: {}",
    ].join("\r\n");
    expect(readBaseConfig(text)).toEqual({ trust: "all", forks: "never" });
  });

  it.each([
    ["a missing file", null],
    ["an empty file", ""],
    ["top-level keys only", "trust: all\nforks: never\n"],
    ["flow-style checks", "checks: {trust: all, forks: never}\n"],
    ["keys nested deeper than checks' own", "checks:\n  jobs:\n    trust: all\n    forks: never\n"],
    ["keys under another section", "deployments:\n  trust: all\n  forks: never\n"],
    ["unknown values", "checks:\n  trust: approve\n  forks: sometimes\n"],
    ["a repeated key", "checks:\n  trust: all\n  trust: all\n  forks: never\n  forks: never\n"],
    ["mismatched quotes", "checks:\n  trust: \"all'\n  forks: 'never\"\n"],
  ])("defaults on %s", (_, text) => {
    expect(readBaseConfig(text)).toEqual(defaults);
  });
});
