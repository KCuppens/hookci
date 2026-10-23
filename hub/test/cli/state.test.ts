import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HubState, STATE_FILE, loadState, saveState } from "../../cli/state.js";

describe("state file", () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "hookci-hub-state-"));
	});

	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	it("round trips through save and load", async () => {
		const state: HubState = {
			account_id: "0123456789abcdef0123456789abcdef",
			d1_database_id: "11111111-2222-3333-4444-555555555555",
			r2_bucket: "hookci-hub-logs",
			base_url: "https://hookci-hub.acme.workers.dev",
			github_app_id: 42,
			version: "1.2.3",
			steps_done: ["account", "d1", "r2"],
		};
		const dir = join(tmp, "nested", "dir");
		await saveState(dir, state);
		expect(await loadState(dir)).toEqual(state);
		await saveState(dir, { ...state, steps_done: [...state.steps_done, "deploy"] });
		expect((await loadState(dir))?.steps_done).toEqual(["account", "d1", "r2", "deploy"]);
		expect(await readdir(dir)).toEqual([STATE_FILE]);
	});

	it("writes the file with mode 0600", async () => {
		await saveState(tmp, { account_id: "a", version: "1.0.0", steps_done: [] });
		expect((await stat(join(tmp, STATE_FILE))).mode & 0o777).toBe(0o600);
	});

	it("loads a partial state written before later steps ran", async () => {
		await writeFile(join(tmp, STATE_FILE), JSON.stringify({ account_id: "a", version: "1.0.0", steps_done: ["account"] }));
		expect(await loadState(tmp)).toEqual({ account_id: "a", version: "1.0.0", steps_done: ["account"] });
	});

	it("returns null when there is no state file", async () => {
		expect(await loadState(tmp)).toBeNull();
	});

	it("rejects a file that is not a state file", async () => {
		await writeFile(join(tmp, STATE_FILE), JSON.stringify({ account_id: "a" }));
		await expect(loadState(tmp)).rejects.toThrow("is not a hookci-hub state file");
	});
});
