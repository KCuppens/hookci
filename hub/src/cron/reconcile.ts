import { getCronState, setCronState } from "../db/cron-state";
import { listActiveReposAfter, type RepoCursor } from "../db/repos";
import { hasRunForSha } from "../db/runs";
import { tenantDb } from "../db/tenant";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { getBranch } from "../github/api";
import { GitHubClient } from "../github/client";
import { defaultFetcher } from "../http";
import { logEvent, reportError } from "../observability";
import type { WaitUntil } from "../sinks";
import { routeTrigger } from "../webhook/route";

const CURSOR_KEY = "reconcile_cursor";
const START: RepoCursor = { repoId: 0, installationId: 0 };
/** A younger head may still have its push webhook on the way. */
const MIN_HEAD_AGE_MS = 10 * 60 * 1000;
/** An older head missed its run long ago; checking it now helps nobody. */
const MAX_HEAD_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Catches default-branch pushes whose webhook never arrived. Each tick checks
 * the next limit repos of active installations, wrapping around to the first,
 * and routes a push trigger for a head commit committed between
 * MAX_HEAD_AGE_MS and MIN_HEAD_AGE_MS ago that has no run.
 */
export async function reconcileDefaultBranches(env: Env, now: number, limit = 50): Promise<{ checked: number; synthesized: number }> {
	const saved = await getCronState(env.DB, CURSOR_KEY);
	const after = saved === null ? START : (JSON.parse(saved) as RepoCursor);
	let repos = await listActiveReposAfter(env.DB, after, limit);
	if (repos.length === 0 && after.repoId !== START.repoId) repos = await listActiveReposAfter(env.DB, START, limit);
	const last = repos.at(-1);
	const next = last === undefined || repos.length < limit ? START : { repoId: last.repo_id, installationId: last.installation_id };

	const clock = env.__TEST_CLOCK ?? systemClock;
	const github = new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, () => clock.now());
	// The cron handler has no ExecutionContext to hand routeTrigger, so its background work is awaited here.
	const pending: Promise<unknown>[] = [];
	const ctx: WaitUntil = { waitUntil: (p) => void pending.push(p) };
	let synthesized = 0;
	for (const repo of repos) {
		try {
			const slash = repo.full_name.indexOf("/");
			const head = await getBranch(
				await github.installation(repo.installation_id),
				repo.full_name.slice(0, slash),
				repo.full_name.slice(slash + 1),
				repo.default_branch,
			);
			const age = now - head.committedAt;
			if (age < MIN_HEAD_AGE_MS || age > MAX_HEAD_AGE_MS) continue;
			if (await hasRunForSha(tenantDb(env.DB, repo.installation_id), repo.repo_id, head.sha)) continue;
			const outcome = await routeTrigger(
				env,
				{
					installationId: repo.installation_id,
					repoId: repo.repo_id,
					repo: repo.full_name,
					sha: head.sha,
					ref: `refs/heads/${repo.default_branch}`,
					event: "push",
					authorLogin: head.authorLogin ?? "",
					authorEmail: head.authorEmail ?? undefined,
					commitTitle: head.title,
					defaultBranch: repo.default_branch,
					target: "checks",
				},
				ctx,
			);
			synthesized++;
			logEvent("reconcile_synthesized", { installation_id: repo.installation_id, repo_id: repo.repo_id, sha: head.sha, outcome: outcome.kind });
		} catch (err) {
			reportError(err, { task: "reconcile", installation_id: repo.installation_id, repo_id: repo.repo_id });
		}
	}
	await Promise.allSettled(pending);
	await setCronState(env.DB, CURSOR_KEY, JSON.stringify(next), now);
	return { checked: repos.length, synthesized };
}
