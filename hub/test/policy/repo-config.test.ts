import { describe, expect, it } from "vitest";
import { branchMatches, readRepoTriggers, triggerConfigRef, triggerWanted } from "../../src/policy/repo-config";

const push = (branch: string) => ({ event: "push" as const, ref: `refs/heads/${branch}`, defaultBranch: "main" });
const PR = { event: "pull_request" as const, ref: "refs/pull/7/head", defaultBranch: "main" };

describe("branchMatches", () => {
  it("lets * stop at a slash and ** cross it", () => {
    expect(branchMatches("feat/*", "feat/a")).toBe(true);
    expect(branchMatches("feat/*", "feat/a/b")).toBe(false);
    expect(branchMatches("feat/**", "feat/a/b")).toBe(true);
    expect(branchMatches("**", "any/thing")).toBe(true);
  });

  it("treats regex characters as literal and matches the whole name", () => {
    expect(branchMatches("v1.2", "v1x2")).toBe(false);
    expect(branchMatches("v1.2", "v1.2")).toBe(true);
    expect(branchMatches("main", "main-old")).toBe(false);
    expect(branchMatches("release+(x)", "release+(x)")).toBe(true);
  });
});

describe("triggerWanted", () => {
  it("runs pull requests and only default-branch pushes when there is no file or the YAML is broken", () => {
    for (const cfg of [readRepoTriggers(null), readRepoTriggers("checks: [unclosed"), readRepoTriggers("just text")]) {
      expect(triggerWanted(cfg, PR)).toBe(true);
      expect(triggerWanted(cfg, push("main"))).toBe(true);
      expect(triggerWanted(cfg, push("feature/x"))).toBe(false);
    }
  });

  it("follows checks.on.pull_request and checks.on.push.branches", () => {
    const cfg = readRepoTriggers("checks:\n  on:\n    pull_request: false\n    push:\n      branches: [develop, 'release/**']\n");
    expect(triggerWanted(cfg, PR)).toBe(false);
    expect(triggerWanted(cfg, push("main"))).toBe(false);
    expect(triggerWanted(cfg, push("develop"))).toBe(true);
    expect(triggerWanted(cfg, push("release/1/rc"))).toBe(true);
  });

  it("always checks a branch a deployment ships from", () => {
    const cfg = readRepoTriggers("checks:\n  on:\n    push:\n      branches: [develop]\ndeployments:\n  prod:\n    on:\n      push: stable\n");
    expect(cfg.deployBranches).toEqual({ prod: "stable" });
    expect(triggerWanted(cfg, push("stable"))).toBe(true);
  });

  it("ignores a branch list with non-string items", () => {
    expect(readRepoTriggers("checks:\n  on:\n    push:\n      branches: [1, main]\n").pushBranches).toBeNull();
  });
});

describe("triggerConfigRef", () => {
  const pr = { number: 7, headRef: "x", baseRef: "main", headRepoFullName: "a/b", authorLogin: "u" };

  it("reads a push or same-repo PR at its own commit", () => {
    expect(triggerConfigRef({ sha: "head", defaultBranch: "main" })).toBe("head");
    expect(triggerConfigRef({ sha: "head", baseSha: "base", defaultBranch: "main", pr: { ...pr, fork: false } })).toBe("head");
  });

  it("reads a fork PR at its base, or the default branch when the base is unknown", () => {
    expect(triggerConfigRef({ sha: "head", baseSha: "base", defaultBranch: "main", pr: { ...pr, fork: true } })).toBe("base");
    expect(triggerConfigRef({ sha: "head", defaultBranch: "main", pr: { ...pr, fork: true } })).toBe("main");
  });
});
