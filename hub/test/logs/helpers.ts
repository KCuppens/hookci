import { env } from "cloudflare:workers";
import { agentCredentialHash, insertAgent } from "../../src/db/agents";
import { insertRun, type NewRun, upsertJob } from "../../src/db/runs";
import { tenantDb } from "../../src/db/tenant";

export async function gzip(text: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

export async function gunzip(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

/** Pairs agentId to the installation under credential `hci_agent_<agentId>`, which it returns. */
export async function seedAgent(installationId: number, agentId: string): Promise<string> {
  const credential = `hci_agent_${agentId}`;
  await insertAgent(tenantDb(env.DB, installationId), {
    agent_id: agentId,
    name: agentId,
    hostname: `${agentId}.local`,
    os: "linux",
    arch: "amd64",
    credential_hash: await agentCredentialHash(credential),
    agent_version: "0.1.0",
    paired_by_github_id: 7001,
    paired_at: 1,
  });
  return credential;
}

/** A failed run of repoId on agentId with one failed job. */
export async function seedRun(installationId: number, repoId: number, runId: string, agentId: string | null, job = "test", over: Partial<NewRun> = {}): Promise<void> {
  const t = tenantDb(env.DB, installationId);
  await insertRun(t, {
    run_id: runId,
    repo_id: repoId,
    sha: "abcdef1234567890abcdef1234567890abcdef12",
    ref: "refs/heads/main",
    event: "push",
    pr_number: null,
    env: null,
    attempt: 1,
    trigger_id: runId,
    agent_id: agentId,
    state: "failed",
    reason: null,
    author_login: "octocat",
    commit_title: "Fix the build",
    started_at: 1,
    finished_at: 2,
    duration_ms: 1,
    log_key: null,
    ...over,
  });
  await upsertJob(t, { run_id: runId, name: job, state: "failed", step: null, step_index: null, steps_total: null, duration_ms: 1 });
}

/** `line 1` to `line count`, one per line. */
export function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join("");
}
