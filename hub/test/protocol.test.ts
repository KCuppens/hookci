import { describe, expect, it } from "vitest";
import type { Event, Trigger } from "../src/protocol/generated";

describe("generated protocol types", () => {
  it("accepts a pull request trigger", () => {
    const trigger: Trigger = {
      v: 1,
      type: "trigger",
      hub_seq: 7,
      trigger_id: "trg_01",
      repo: "acme/web",
      sha: "0123456789abcdef0123456789abcdef01234567",
      ref: "refs/pull/42/head",
      event: "pull_request",
      pr: { number: 42, head_ref: "feature", head_repo_full_name: "fork/web", fork: true },
      base_sha: "89abcdef0123456789abcdef0123456789abcdef",
      attempt: 1,
      trust: "untrusted",
    };
    expect(JSON.parse(JSON.stringify(trigger))).toEqual(trigger);
  });

  it("accepts a failed job event", () => {
    const event: Event = {
      v: 1,
      type: "event",
      agent_seq: 3,
      run_id: "01j7run",
      job: "lint",
      state: "failed",
      duration_ms: 1200,
      tail: ["error: unused variable"],
    };
    expect(event.state).toBe("failed");
  });

  it("rejects a frame with another protocol version", () => {
    const trigger: Trigger = {
      // @ts-expect-error v is the literal 1
      v: 2,
      type: "trigger",
      hub_seq: 1,
      trigger_id: "trg_02",
      repo: "acme/web",
      sha: "0123456789abcdef0123456789abcdef01234567",
      ref: "refs/heads/main",
      event: "push",
      attempt: 1,
      trust: "trusted",
    };
    expect(trigger.v).toBe(2);
  });
});
