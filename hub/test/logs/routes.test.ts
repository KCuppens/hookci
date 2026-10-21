import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertInstallation } from "../../src/db/installations";
import { LOG_URL_TTL_SECONDS, signLogUrl } from "../../src/logs/sign";
import { QUOTAS } from "../../src/quotas";
import { testClock } from "../clock";
import { clearTables } from "../db/helpers";
import { gunzip, gzip, seedAgent, seedRun } from "./helpers";

const INSTALLATION = 31;
const OTHER = 32;
const REPO_ID = 3100;
const RUN = "run_logs_1";
const KEY = `logs/${INSTALLATION}/${RUN}/test.log.gz`;
const LOG = "go test ./...\n--- FAIL: TestHub\nFAIL\n";

let owner: string;
let stranger: string;

beforeEach(async () => {
  await clearTables();
  await env.LOGS.delete(KEY);
  for (const id of [INSTALLATION, OTHER]) {
    await upsertInstallation(env.DB, { id, account_login: `acct${id}`, account_type: "Organization", account_id: id * 10, created_at: 1 });
  }
  owner = await seedAgent(INSTALLATION, "agt_owner");
  stranger = await seedAgent(OTHER, "agt_stranger");
  await seedRun(INSTALLATION, REPO_ID, RUN, "agt_owner");
});

function put(credential: string, body: BodyInit, headers: Record<string, string> = {}, job = "test"): Promise<Response> {
  return exports.default.fetch(`https://hub.test/v1/logs/${RUN}/${job}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-encoding": "gzip",
      "x-hookci-log-bytes": String(LOG.length),
      "x-hookci-log-truncated": "0",
      ...headers,
    },
    body,
  });
}

async function jobLog(): Promise<{ log_key: string | null; log_bytes: number | null; log_truncated: number | null } | null> {
  return env.DB.prepare("SELECT log_key, log_bytes, log_truncated FROM jobs WHERE run_id = ?1 AND name = 'test'")
    .bind(RUN)
    .first<{ log_key: string | null; log_bytes: number | null; log_truncated: number | null }>();
}

describe("PUT /v1/logs/:runId/:job", () => {
  it("stores the gzipped log under the installation's prefix and records it on the job", async () => {
    const res = await put(owner, await gzip(LOG), { "x-hookci-log-truncated": "1" });
    expect(res.status).toBe(204);
    const object = await env.LOGS.get(KEY);
    expect(object?.httpMetadata).toMatchObject({ contentEncoding: "gzip", contentType: "text/plain; charset=utf-8" });
    expect(await gunzip(await (object ?? new Response()).arrayBuffer())).toBe(LOG);
    expect(await jobLog()).toEqual({ log_key: KEY, log_bytes: LOG.length, log_truncated: 1 });
  });

  it("accepts the legacy x-zeroci-log-* headers and an hc_agent_ credential", async () => {
    const res = await exports.default.fetch(`https://hub.test/v1/logs/${RUN}/test`, {
      method: "PUT",
      headers: { authorization: `Bearer ${owner}`, "content-encoding": "gzip", "x-zeroci-log-bytes": String(LOG.length), "x-zeroci-log-truncated": "1" },
      body: await gzip(LOG),
    });
    expect(res.status).toBe(204);
    expect(await jobLog()).toEqual({ log_key: KEY, log_bytes: LOG.length, log_truncated: 1 });
  });

  it("refuses an agent of another installation with 403 and stores nothing", async () => {
    const res = await put(stranger, await gzip(LOG));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect((await env.LOGS.list({ prefix: "logs/" })).objects).toEqual([]);
    expect(await jobLog()).toEqual({ log_key: null, log_bytes: null, log_truncated: 0 });
  });

  it("refuses an agent of the same installation that does not run the job", async () => {
    const sibling = await seedAgent(INSTALLATION, "agt_sibling");
    expect((await put(sibling, await gzip(LOG))).status).toBe(403);
  });

  it("refuses a missing or unknown credential with 401", async () => {
    expect((await put("zc_agent_nobody", await gzip(LOG))).status).toBe(401);
    expect((await put("ghs_token", await gzip(LOG))).status).toBe(401);
  });

  it("refuses a job name that would leave the run's prefix with 400 bad_job_name", async () => {
    const res = await put(owner, await gzip(LOG), {}, "..%2Fx");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_job_name" });
    expect((await env.LOGS.list({ prefix: "logs/" })).objects).toEqual([]);
  });

  it("refuses a declared size over the cap with 413 log_too_large", async () => {
    const res = await put(owner, await gzip(LOG), { "x-hookci-log-bytes": String(QUOTAS.logBytes + 1) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "log_too_large" });
  });

  it("refuses a streamed body over the cap with 413 log_too_large", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > QUOTAS.logBytes) controller.close();
        else {
          controller.enqueue(chunk);
          sent += chunk.byteLength;
        }
      },
    });
    const res = await put(owner, body);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "log_too_large" });
    expect(await env.LOGS.head(KEY)).toBeNull();
  });

  it.each([
    ["no gzip encoding", { "content-encoding": "identity" }, 415, "log_not_gzip"],
    ["a size that is not a number", { "x-hookci-log-bytes": "12kB" }, 400, "bad_log_bytes"],
    ["a truncated flag other than 0 or 1", { "x-hookci-log-truncated": "yes" }, 400, "bad_log_truncated"],
  ])("refuses %s", async (_name, headers, status, error) => {
    const res = await put(owner, await gzip(LOG), headers);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });
});

describe("GET /logs/:runId/:job", () => {
  beforeEach(async () => {
    await env.LOGS.put(KEY, await gzip(LOG));
  });

  it("serves the gzipped log to a signed link without caching or indexing", async () => {
    const res = await exports.default.fetch(await signLogUrl(env, RUN, "test"), { encodeResponseBody: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await gunzip(await res.arrayBuffer())).toBe(LOG);
  });

  it("forbids sniffing and sandboxes the log, which holds output a fork pull request controls", async () => {
    const res = await exports.default.fetch(await signLogUrl(env, RUN, "test"), { encodeResponseBody: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("content-disposition")).toBe("inline");
  });

  it("answers 410 log_expired once the link is 15 minutes old", async () => {
    const url = await signLogUrl(env, RUN, "test");
    testClock.advance(LOG_URL_TTL_SECONDS * 1000);
    const res = await exports.default.fetch(url);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "log_expired" });
  });

  it("answers 403 log_sig_invalid to a changed signature or job", async () => {
    const url = new URL(await signLogUrl(env, RUN, "test"));
    const sig = url.searchParams.get("sig") ?? "";
    const tampered = new URL(url);
    tampered.searchParams.set("sig", `${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`);
    for (const target of [tampered.toString(), url.toString().replace("/test?", "/deploy?")]) {
      const res = await exports.default.fetch(target);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "log_sig_invalid" });
    }
  });

  it("answers 404 log_not_found when the job has no stored log", async () => {
    const res = await exports.default.fetch(await signLogUrl(env, RUN, "lint"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "log_not_found" });
  });
});
