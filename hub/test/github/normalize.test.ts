import { describe, expect, it } from "vitest";
import { normalize } from "../../src/github/normalize";
import prClosed from "../fixtures/github/pull_request.closed.json";
import prOpened from "../fixtures/github/pull_request.opened.json";
import prFork from "../fixtures/github/pull_request.synchronize.fork.json";
import pushBranch from "../fixtures/github/push.branch.json";
import pushDeleted from "../fixtures/github/push.deleted.json";
import pushMain from "../fixtures/github/push.main.json";
import pushTag from "../fixtures/github/push.tag.json";

const HEAD = "8d3f9a1c5b7e2d4f6a8c0e1b3d5f7a9c1e3b5d7f";
const BASE = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

describe("normalize pull_request", () => {
  it("turns an opened same-repo pull request into a checks trigger", () => {
    expect(normalize("pull_request", prOpened)).toEqual({
      installationId: 42,
      repoId: 1001,
      repo: "acme/widgets",
      sha: HEAD,
      ref: "refs/pull/7/head",
      event: "pull_request",
      pr: { number: 7, headRef: "feature/sizing", headRepoFullName: "acme/widgets", fork: false, authorLogin: "alice" },
      baseSha: BASE,
      authorLogin: "alice",
      commitTitle: "Add widget sizing",
      defaultBranch: "main",
      target: "checks",
    });
  });

  it("marks a pull request from another repository as a fork", () => {
    const trig = normalize("pull_request", prFork);
    expect(trig?.pr).toEqual({ number: 9, headRef: "patch-1", headRepoFullName: "mallory/widgets", fork: true, authorLogin: "mallory" });
    expect(trig?.sha).toBe("f00dfacecafebeef0123456789abcdef01234567");
    expect(trig?.ref).toBe("refs/pull/9/head");
  });

  it("treats a pull request whose head repository was deleted as a fork", () => {
    const payload = { ...prFork, pull_request: { ...prFork.pull_request, head: { ...prFork.pull_request.head, repo: null } } };
    expect(normalize("pull_request", payload)?.pr?.fork).toBe(true);
  });

  it("starts runs for synchronize, reopened and ready_for_review", () => {
    for (const action of ["synchronize", "reopened", "ready_for_review"]) {
      expect(normalize("pull_request", { ...prOpened, action })?.sha).toBe(HEAD);
    }
  });

  it("ignores a closed pull request", () => {
    expect(normalize("pull_request", prClosed)).toBeNull();
  });

  it("rejects a payload missing the head sha", () => {
    const payload = { ...prOpened, pull_request: { ...prOpened.pull_request, head: { ...prOpened.pull_request.head, sha: undefined } } };
    expect(() => normalize("pull_request", payload)).toThrow(/pull_request\.head\.sha/);
  });
});

describe("normalize push", () => {
  it("turns a push to the default branch into a checks trigger", () => {
    expect(normalize("push", pushMain)).toEqual({
      installationId: 42,
      repoId: 1001,
      repo: "acme/widgets",
      sha: HEAD,
      ref: "refs/heads/main",
      event: "push",
      baseSha: BASE,
      authorLogin: "alice",
      authorEmail: "alice@example.com",
      commitTitle: "Fix flaky retry test",
      defaultBranch: "main",
      target: "checks",
    });
  });

  it("falls back to the sender when the commit author has no GitHub account", () => {
    const author = { name: "Bot", email: "bot@example.com" };
    const trig = normalize("push", { ...pushMain, head_commit: { ...pushMain.head_commit, author } });
    expect(trig?.authorLogin).toBe("alice");
    expect(trig?.authorEmail).toBe("bot@example.com");
  });

  it("ignores a push to another branch", () => {
    expect(normalize("push", pushBranch)).toBeNull();
  });

  it("ignores a branch deletion", () => {
    expect(normalize("push", pushDeleted)).toBeNull();
  });

  it("ignores a tag push, even one that carries commits", () => {
    expect(normalize("push", pushTag)).toBeNull();
    expect(normalize("push", { ...pushTag, commits: pushMain.commits })).toBeNull();
  });

  it("ignores a push without commits", () => {
    expect(normalize("push", { ...pushMain, commits: [] })).toBeNull();
  });
});

describe("normalize other events", () => {
  it("returns null for events that start no run", () => {
    expect(normalize("check_suite", prOpened)).toBeNull();
  });
});
