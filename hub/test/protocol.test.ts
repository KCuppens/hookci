import { describe, expect, it } from "vitest";
import { encodeFrame, parseFrame, ProtocolError, type Event, type Frame, type Trigger } from "../src/protocol";
import { capacityFrame } from "./helpers/capacity";

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

function parseError(text: string): ProtocolError {
  try {
    parseFrame(text);
  } catch (err) {
    if (err instanceof ProtocolError) return err;
    throw err;
  }
  throw new Error(`parseFrame accepted ${text}`);
}

describe("parseFrame", () => {
  it("parses a welcome and round-trips it through encodeFrame", () => {
    const welcome: Frame = {
      v: 1,
      type: "welcome",
      hub_version: "1.4.0",
      protocol_min: 1,
      protocol_max: 1,
      agent_id: "agt_01",
      installation_id: 4242,
    };
    expect(parseFrame(encodeFrame(welcome))).toEqual(welcome);
  });

  it("parses an interrupt with either id", () => {
    expect(parseFrame('{"v":1,"type":"interrupt","run_id":"r1","reason":"superseded"}')).toMatchObject({ run_id: "r1" });
    expect(parseFrame('{"v":1,"type":"interrupt","trigger_id":"t1","reason":"revoked"}')).toMatchObject({ trigger_id: "t1" });
  });

  it("parses capacity and budget frames", () => {
    const capacity = capacityFrame();
    expect(parseFrame(encodeFrame(capacity))).toEqual(capacity);
    expect(parseFrame('{"v":1,"type":"budget","cpus":null,"memory_bytes":null}')).toMatchObject({ type: "budget", cpus: null });
    expect(parseError('{"v":1,"type":"budget","cpus":2}').message).toContain("memory_bytes");
  });

  it.each([
    ["not JSON", "{", "not valid JSON"],
    ["an array", "[]", "not a JSON object"],
    ["another version", '{"v":2,"type":"ack","upto":1}', "v is not 1"],
    ["an unknown type", '{"v":1,"type":"nope"}', "missing or unknown"],
    ["a missing required key", '{"v":1,"type":"error","code":"internal"}', "error frame lacks message"],
    ["both interrupt ids", '{"v":1,"type":"interrupt","run_id":"r1","trigger_id":"t1","reason":"repair"}', "exactly one"],
    ["no interrupt id", '{"v":1,"type":"interrupt","reason":"repair"}', "exactly one"],
  ])("rejects %s with bad_frame", (_name, text, message) => {
    const err = parseError(text);
    expect(err.code).toBe("bad_frame");
    expect(err.message).toContain(message);
  });
});
