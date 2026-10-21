import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseD1Create, parseD1List, parseDeployUrl, parseMigrationsList, parseR2List, parseWhoami } from "../../cli/parse.js";
import { SetupError } from "../../cli/setup.js";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", name), "utf8");

function parseFailure(fn: () => unknown): void {
	try {
		fn();
	} catch (err) {
		if (!(err instanceof SetupError)) throw err;
		expect(err.code).toBe("parse_failed");
		return;
	}
	expect.unreachable("parser accepted malformed input");
}

describe("parseWhoami", () => {
	it("reads one account from the table", async () => {
		expect(parseWhoami(await fixture("whoami-one.txt"))).toEqual({ accounts: [{ name: "Acme Inc", id: "0123456789abcdef0123456789abcdef" }] });
	});

	it("reads every account and ignores colour codes", async () => {
		const coloured = (await fixture("whoami-two.txt")).replaceAll("│", "\u001b[90m│\u001b[39m");
		expect(parseWhoami(coloured).accounts).toEqual([
			{ name: "Acme Inc", id: "0123456789abcdef0123456789abcdef" },
			{ name: "Acme Labs", id: "fedcba9876543210fedcba9876543210" },
		]);
	});

	it("rejects output without an account table", () => {
		parseFailure(() => parseWhoami("Getting User settings...\nYou are not authenticated. Please run `wrangler login`.\n"));
	});
});

describe("parseD1Create", () => {
	it("reads the database_id from the JSON snippet", async () => {
		expect(parseD1Create(await fixture("d1-create.txt"))).toBe("5b0c7f4e-2a1d-4c3b-9e8f-1a2b3c4d5e6f");
	});

	it("reads the database_id from the TOML snippet", () => {
		const out = [
			"\u001b[32m✅ Successfully created DB 'hookci-hub-db'\u001b[39m",
			"",
			"[[d1_databases]]",
			'binding = "hookci_hub_db"',
			'database_name = "hookci-hub-db"',
			'database_id = "0f1e2d3c-4b5a-4697-8877-665544332211"',
		].join("\n");
		expect(parseD1Create(out)).toBe("0f1e2d3c-4b5a-4697-8877-665544332211");
	});

	it("rejects output without a database_id", () => {
		parseFailure(() => parseD1Create("✅ Successfully created DB 'hookci-hub-db'\n"));
	});
});

describe("parseD1List", () => {
	it("reads uuid and name of every database", async () => {
		expect(parseD1List(await fixture("d1-list.json"))).toEqual([
			{ uuid: "9d2f3c1a-7b6e-4f5d-8c9b-0a1b2c3d4e5f", name: "other-app-db" },
			{ uuid: "1f2e3d4c-5b6a-4789-8a7b-6c5d4e3f2a1b", name: "hookci-hub-db" },
		]);
		expect(parseD1List("[]\n")).toEqual([]);
	});

	it("rejects anything but an array of databases", () => {
		parseFailure(() => parseD1List("✘ [ERROR] Authentication error"));
		parseFailure(() => parseD1List('{"uuid":"x"}'));
		parseFailure(() => parseD1List('[{"name":"hookci-hub-db"}]'));
	});
});

describe("parseR2List", () => {
	it("reads every bucket name", async () => {
		expect(parseR2List(await fixture("r2-list.txt"))).toEqual(["other-app-assets", "hookci-hub-logs"]);
		expect(parseR2List("Listing buckets...\n")).toEqual([]);
	});

	it("rejects a name line that holds no bucket name", () => {
		parseFailure(() => parseR2List("Listing buckets...\nname:\ncreation_date:  2026-01-15T08:31:00.000Z\n"));
	});
});

describe("parseDeployUrl", () => {
	it("returns the workers.dev URL from the trigger list", async () => {
		expect(parseDeployUrl(await fixture("deploy.txt"))).toBe("https://hookci-hub.acme.workers.dev");
	});

	it("returns a custom domain target as an https URL", () => {
		expect(parseDeployUrl("Deployed hookci-hub triggers (0.80 sec)\n  ci.acme.dev (custom domain)\n  schedule: */5 * * * *\n")).toBe("https://ci.acme.dev");
	});

	it("returns null when wrangler lists no URL", () => {
		expect(parseDeployUrl("No targets deployed for hookci-hub (0.20 sec)\n")).toBeNull();
	});
});

describe("parseMigrationsList", () => {
	it("reads every name in the table of migrations to apply", async () => {
		expect(parseMigrationsList(await fixture("d1-migrations-list-pending.txt"))).toEqual(["0015_sink_retries.sql", "0016_agent_versions.sql"]);
	});

	it("returns no names when there is nothing to apply", async () => {
		expect(parseMigrationsList(await fixture("d1-migrations-list-none.txt"))).toEqual([]);
	});

	it("rejects output with neither a table nor the nothing-to-apply line", () => {
		parseFailure(() => parseMigrationsList("✘ [ERROR] Couldn't find a D1 DB with the name or binding 'hookci-hub-db'\n"));
		parseFailure(() => parseMigrationsList("Migrations to be applied:\n┌──────┐\n│ Name │\n└──────┘\n"));
	});
});
