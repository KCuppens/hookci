import { stripVTControlCharacters } from "node:util";
import { SetupError } from "./setup.js";

// Parsers for what the pinned wrangler prints. Colour codes are stripped first.

const ACCOUNT_ROW = /^[│|]\s*(.*?)\s*[│|]\s*([0-9a-f]{32})\s*[│|]$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const D1_ID_TOML = new RegExp(`^\\s*database_id\\s*=\\s*"(${UUID})"\\s*$`, "m");
const D1_ID_JSON = new RegExp(`"database_id"\\s*:\\s*"(${UUID})"`);
const R2_NAME_LINE = /^name:\s*(.*)$/;
const R2_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const WORKERS_DEV_URL = /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev\b/i;
const CUSTOM_DOMAIN_LINE = /^\s*([a-z0-9-]+(?:\.[a-z0-9-]+)+)\s+\(custom domain\)\s*$/i;
const NO_MIGRATIONS = /No migrations to apply/;
const MIGRATIONS_HEADER = "Migrations to be applied:";
const TABLE_CELL = /^[│|]\s*(.*?)\s*[│|]$/;

function lines(stdout: string): string[] {
	return stripVTControlCharacters(stdout)
		.split(/\r?\n/)
		.map((l) => l.trim());
}

/** The accounts in the "Account Name | Account ID" table `wrangler whoami` prints. */
export function parseWhoami(stdout: string): { accounts: { id: string; name: string }[] } {
	const accounts: { id: string; name: string }[] = [];
	for (const line of lines(stdout)) {
		const m = ACCOUNT_ROW.exec(line);
		if (m) accounts.push({ name: m[1] as string, id: m[2] as string });
	}
	if (accounts.length === 0) throw new SetupError("parse_failed", "wrangler whoami printed no Cloudflare account");
	return { accounts };
}

/** The database_id from the TOML or JSON config snippet `wrangler d1 create` prints. */
export function parseD1Create(stdout: string): string {
	const text = stripVTControlCharacters(stdout);
	const id = D1_ID_TOML.exec(text)?.[1] ?? D1_ID_JSON.exec(text)?.[1];
	if (!id) throw new SetupError("parse_failed", "wrangler d1 create printed no database_id");
	return id;
}

/** The databases in `wrangler d1 list --json` output. */
export function parseD1List(stdout: string): { uuid: string; name: string }[] {
	const text = stripVTControlCharacters(stdout);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(text.indexOf("[")));
	} catch {
		throw new SetupError("parse_failed", "wrangler d1 list --json printed no JSON array");
	}
	if (!Array.isArray(parsed)) throw new SetupError("parse_failed", "wrangler d1 list --json printed no JSON array");
	return parsed.map((db: unknown) => {
		if (typeof db === "object" && db !== null && "uuid" in db && "name" in db && typeof db.uuid === "string" && typeof db.name === "string") {
			return { uuid: db.uuid, name: db.name };
		}
		throw new SetupError("parse_failed", "wrangler d1 list --json printed a database without uuid and name");
	});
}

/** The bucket names in the `name:` lines `wrangler r2 bucket list` prints. */
export function parseR2List(stdout: string): string[] {
	const buckets: string[] = [];
	for (const line of lines(stdout)) {
		const m = R2_NAME_LINE.exec(line);
		if (!m) continue;
		const name = (m[1] as string).trim();
		if (!R2_BUCKET.test(name)) throw new SetupError("parse_failed", `wrangler r2 bucket list printed an invalid bucket name "${name}"`);
		buckets.push(name);
	}
	return buckets;
}

/** The first workers.dev URL or custom domain `wrangler deploy` lists under its triggers; null when there is none. */
export function parseDeployUrl(stdout: string): string | null {
	for (const line of lines(stdout)) {
		const url = WORKERS_DEV_URL.exec(line)?.[0];
		if (url) return url;
		const domain = CUSTOM_DOMAIN_LINE.exec(line)?.[1];
		if (domain) return `https://${domain}`;
	}
	return null;
}

/** The names in the table `wrangler d1 migrations list` prints; empty when it has no migrations to apply. */
export function parseMigrationsList(stdout: string): string[] {
	const all = lines(stdout);
	if (all.some((l) => NO_MIGRATIONS.test(l))) return [];
	const start = all.indexOf(MIGRATIONS_HEADER);
	if (start < 0) throw new SetupError("parse_failed", 'wrangler d1 migrations list printed neither a migration table nor "No migrations to apply"');
	const names: string[] = [];
	for (const line of all.slice(start + 1)) {
		const name = TABLE_CELL.exec(line)?.[1];
		if (name && name !== "Name") names.push(name);
	}
	if (names.length === 0) throw new SetupError("parse_failed", "wrangler d1 migrations list printed an empty migration table");
	return names;
}
