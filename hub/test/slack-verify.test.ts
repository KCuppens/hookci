import { describe, expect, it } from "vitest";
import { hex, hmacSha256 } from "../src/crypto";
import { HubError } from "../src/errors";
import { verifySlackRequest } from "../src/slack/verify";

const CURRENT = "current-signing-secret";
const PREVIOUS = "previous-signing-secret";
const NOW_MS = 1_767_225_600_000;
const BODY = "token=x&team_id=T1&user_id=U1&command=%2Fzeroci&text=status";

async function signed(secret: string, timestampSec: number, body: string): Promise<Headers> {
  const signature = `v0=${hex(await hmacSha256(secret, `v0:${timestampSec}:${body}`))}`;
  return new Headers({ "x-slack-request-timestamp": String(timestampSec), "x-slack-signature": signature });
}

async function failure(promise: Promise<void>): Promise<{ code: string; status: number }> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof HubError)) throw new Error(`expected a HubError, got ${String(err)}`);
  return { code: err.code, status: err.status };
}

describe("verifySlackRequest", () => {
  const now = NOW_MS / 1000;

  it("accepts a request signed with the current secret", async () => {
    await expect(verifySlackRequest(BODY, await signed(CURRENT, now, BODY), [CURRENT, PREVIOUS], NOW_MS)).resolves.toBeUndefined();
  });

  it("accepts a request signed with the previous secret during a rotation", async () => {
    await expect(verifySlackRequest(BODY, await signed(PREVIOUS, now, BODY), [CURRENT, PREVIOUS], NOW_MS)).resolves.toBeUndefined();
  });

  it("refuses a previous-secret signature once no previous secret is configured", async () => {
    expect(await failure(verifySlackRequest(BODY, await signed(PREVIOUS, now, BODY), [CURRENT], NOW_MS))).toEqual({
      code: "slack_bad_signature",
      status: 401,
    });
  });

  it("refuses a timestamp 301 s old as stale and accepts one 300 s old", async () => {
    expect(await failure(verifySlackRequest(BODY, await signed(CURRENT, now - 301, BODY), [CURRENT], NOW_MS))).toEqual({
      code: "slack_stale",
      status: 401,
    });
    await expect(verifySlackRequest(BODY, await signed(CURRENT, now - 300, BODY), [CURRENT], NOW_MS)).resolves.toBeUndefined();
  });

  it("refuses a timestamp 301 s in the future as stale", async () => {
    expect(await failure(verifySlackRequest(BODY, await signed(CURRENT, now + 301, BODY), [CURRENT], NOW_MS))).toMatchObject({
      code: "slack_stale",
    });
  });

  it("refuses a body changed after signing", async () => {
    const headers = await signed(CURRENT, now, BODY);
    expect(await failure(verifySlackRequest(BODY.replace("status", "delete-my-data"), headers, [CURRENT], NOW_MS))).toEqual({
      code: "slack_bad_signature",
      status: 401,
    });
  });

  it("refuses a request without signature headers", async () => {
    expect(await failure(verifySlackRequest(BODY, new Headers(), [CURRENT], NOW_MS))).toEqual({ code: "slack_bad_signature", status: 401 });
  });
});
