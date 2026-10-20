import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const STATE_FILE = "zeroci-hub.state.json";

/** What setup has learned and done so far. Holds resource ids only, never secret values. */
export interface HubState {
	account_id: string;
	d1_database_id?: string;
	r2_bucket?: string;
	base_url?: string;
	github_app_id?: number;
	/** Hub name: the Worker name and the prefix of the D1 database and R2 bucket. */
	name?: string;
	custom_domain?: string;
	/** Names of the Worker secrets setup has stored; the values are never written down. */
	secrets_set?: string[];
	version: string;
	steps_done: string[];
}

function isHubState(v: unknown): v is HubState {
	if (typeof v !== "object" || v === null) return false;
	const s = v as Record<string, unknown>;
	return (
		typeof s.account_id === "string" &&
		typeof s.version === "string" &&
		Array.isArray(s.steps_done) &&
		s.steps_done.every((step) => typeof step === "string")
	);
}

/** Reads `<dir>/zeroci-hub.state.json`; null when setup has never saved state there. */
export async function loadState(dir: string): Promise<HubState | null> {
	const path = join(dir, STATE_FILE);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	const parsed: unknown = JSON.parse(raw);
	if (!isHubState(parsed)) throw new Error(`${path} is not a zeroci-hub state file (needs account_id, version and steps_done)`);
	return parsed;
}

/** Writes the state file with mode 0600 through a temp file and rename, so a crash never leaves it half written. */
export async function saveState(dir: string, s: HubState): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, STATE_FILE);
	const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		const fh = await open(tmp, "wx", 0o600);
		try {
			await fh.writeFile(`${JSON.stringify(s, null, 2)}\n`);
			await fh.sync();
		} finally {
			await fh.close();
		}
		await rename(tmp, path);
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
}
