// Deletes the data of GitHub installations whose 24 h grace after uninstall
// has passed: their R2 logs first, then every tenant row, so a failure
// part-way leaves the installation due and the next tick finishes it.

import { listPurgeDue, purgeInstallation } from "../db/installations";
import type { Env } from "../env";
import { reportError } from "../observability";

const INSTALLATIONS_PER_TICK = 5;

/** R2 list and delete both take at most 1000 keys. */
const R2_BATCH = 1000;

async function deleteLogs(bucket: R2Bucket, installationId: number): Promise<void> {
	const prefix = `logs/${installationId}/`;
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor, limit: R2_BATCH });
		if (page.objects.length > 0) await bucket.delete(page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor !== undefined);
}

/**
 * Purges up to five due installations, oldest first, and returns the ids it
 * purged. One that fails is reported and stays due; the rest still go.
 */
export async function purgeDeletedInstallations(env: Env, now: number): Promise<number[]> {
	const purged: number[] = [];
	for (const id of await listPurgeDue(env.DB, now, INSTALLATIONS_PER_TICK)) {
		try {
			await deleteLogs(env.LOGS, id);
			await purgeInstallation(env.DB, id);
			purged.push(id);
		} catch (err) {
			reportError(err, { task: "purge_installations", installation_id: id });
		}
	}
	return purged;
}
