import { purgeExpired } from "../db/purge";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { GitHubClient } from "../github/client";
import { defaultFetcher } from "../http";
import { reportError } from "../observability";
import { purgeDeletedInstallations } from "./purge-installations";
import { reconcileDefaultBranches } from "./reconcile";
import { redeliverFailed } from "./redeliver";
import { reencryptTokens } from "./reencrypt";
import { runStatusChecks } from "./status-check";

type CronTask = { name: string; run(env: Env, now: number): Promise<unknown> };

// Tasks per cron expression from wrangler.toml [triggers].
const SCHEDULES: Record<string, readonly CronTask[]> = {
	"*/5 * * * *": [
		{
			name: "redeliver",
			run: async (env, now) => {
				const clock = env.__TEST_CLOCK ?? systemClock;
				const github = new GitHubClient(env, env.__TEST_FETCHER ?? defaultFetcher, () => clock.now());
				return redeliverFailed(env, await github.app(), now);
			},
		},
		{ name: "reconcile", run: (env, now) => reconcileDefaultBranches(env, now) },
		{ name: "purge", run: (env, now) => purgeExpired(env.DB, now) },
		{ name: "purge_installations", run: (env, now) => purgeDeletedInstallations(env, now) },
		{ name: "reencrypt", run: (env, now) => reencryptTokens(env, now) },
		{ name: "status_check", run: (env, now) => runStatusChecks(env, now) },
	],
};

/** Runs the tasks for cron in order; a failing task is reported and does not stop the rest. */
export async function runCron(env: Env, cron: string): Promise<void> {
	const now = (env.__TEST_CLOCK ?? systemClock).now();
	for (const task of SCHEDULES[cron] ?? []) {
		try {
			await task.run(env, now);
		} catch (err) {
			reportError(err, { task: task.name, cron });
		}
	}
}
