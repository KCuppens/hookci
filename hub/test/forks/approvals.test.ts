import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { tenantDb } from "../../src/db/tenant";
import { consumeApproval, deleteApprovalsByUser, recordApproval } from "../../src/forks/approvals";
import { INSTALLATION, REPO, setUpCommandWorld } from "../commands-helpers";
import { deliver } from "./world";

const APPROVER = 7001;
const OTHER = 9009;
const db = () => tenantDb(env.DB, INSTALLATION);

async function approvals(): Promise<{ head_sha: string; approved_by_github_id: number; used: boolean }[]> {
  const rows = await env.DB.prepare("SELECT head_sha, approved_by_github_id, used_at FROM fork_approvals ORDER BY head_sha").all<{
    head_sha: string;
    approved_by_github_id: number;
    used_at: number | null;
  }>();
  return rows.results.map((r) => ({ head_sha: r.head_sha, approved_by_github_id: r.approved_by_github_id, used: r.used_at !== null }));
}

beforeEach(async () => {
  (await setUpCommandWorld()).restore();
  for (const [sha, by] of [["a1", APPROVER], ["b2", APPROVER], ["c3", OTHER]] as const) {
    await recordApproval(db(), { repoId: REPO.repo_id, prNumber: 9, headSha: sha, approvedByGithubId: by });
  }
  await consumeApproval(db(), { repoId: REPO.repo_id, prNumber: 9, headSha: "a1" });
});

describe("fork approvals", () => {
  it("spends an approval once", async () => {
    const key = { repoId: REPO.repo_id, prNumber: 9, headSha: "b2" };
    expect(await consumeApproval(db(), key)).toBe(true);
    expect(await consumeApproval(db(), key)).toBe(false);
  });

  it("deleteApprovalsByUser removes the user's unused approvals and keeps used ones", async () => {
    expect(await deleteApprovalsByUser(env, APPROVER)).toBe(1);
    expect(await approvals()).toEqual([
      { head_sha: "a1", approved_by_github_id: APPROVER, used: true },
      { head_sha: "c3", approved_by_github_id: OTHER, used: false },
    ]);
  });

  it("github_app_authorization revoked deletes the sender's unused approvals", async () => {
    const res = await deliver("github_app_authorization", { action: "revoked", sender: { id: APPROVER, login: "octocat" } });
    expect(res.ok).toBe(true);
    expect((await approvals()).map((a) => a.head_sha)).toEqual(["a1", "c3"]);
  });
});
