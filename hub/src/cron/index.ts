import { purgeExpired } from "../db/deliveries";
import { systemClock } from "../do/clock";
import type { Env } from "../env";
import { reportError } from "../observability";
import { reencryptTokens } from "./reencrypt";

type CronTask = { name: string; run(env: Env): Promise<unknown> };

// Tasks per cron expression from wrangler.toml [triggers].
const SCHEDULES: Record<string, readonly CronTask[]> = {
	"*/5 * * * *": [
		{ name: "reencrypt", run: reencryptTokens },
		{ name: "purge", run: (env) => purgeExpired(env.DB, (env.__TEST_CLOCK ?? systemClock).now()) },
	],
};

/** Runs the tasks for cron in order; a failing task is reported and does not stop the rest. */
export async function runCron(env: Env, cron: string): Promise<void> {
	for (const task of SCHEDULES[cron] ?? []) {
		try {
			await task.run(env);
		} catch (err) {
			reportError(err, { task: task.name, cron });
		}
	}
}
