#!/usr/bin/env node
// Checks the listing copy in docs/marketplace/ against the production app
// manifests: the Slack bot scopes table equals oauth_config.scopes.bot, every
// GitHub App permission (with its access level) and webhook event has a row,
// the GitHub short description is at most 80 characters, and the docs hold no
// en or em dash. Prints what differs and exits 1 on any mismatch.
// --slack-manifest <path> and --github-manifest <path> check other manifests.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "docs", "marketplace");
const SHORT_MAX = 80;

function flag(name, fallback) {
	const i = process.argv.indexOf(name);
	if (i === -1) return fallback;
	const value = process.argv[i + 1];
	if (value === undefined || value.startsWith("--")) {
		console.error(`check-marketplace: ${name} needs a path`);
		process.exit(2);
	}
	return value;
}

const slackManifest = flag("--slack-manifest", join(root, "hub", "manifests", "slack-app.yml"));
const githubManifest = flag("--github-manifest", join(root, "hub", "manifests", "github-app.json"));

/** The lines under a `## title` heading, up to the next `## ` heading. */
function section(text, file, title) {
	const lines = text.split("\n");
	const start = lines.indexOf(`## ${title}`);
	if (start === -1) throw new Error(`check-marketplace: ${file} has no "## ${title}" section`);
	const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
	return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** The cells of each markdown table body row in lines, header and separator skipped. */
function tableRows(lines) {
	const rows = lines.filter((line) => line.startsWith("|")).map((line) => line.slice(1, line.endsWith("|") ? -1 : undefined).split("|").map((cell) => cell.trim()));
	return rows.slice(2);
}

/** The name inside backticks, or the cell itself. */
function unquote(cell) {
	const m = /^`([^`]+)`$/.exec(cell);
	return m ? m[1] : cell;
}

/**
 * The items of the block list at oauth_config > scopes > bot in a Slack
 * manifest. Tracks the mapping keys that enclose each line by indentation,
 * which is all of YAML the manifest uses.
 */
function slackBotScopes(yaml, file) {
	const target = "oauth_config.scopes.bot";
	const keys = [];
	let found = false;
	const scopes = [];
	for (const raw of yaml.split("\n")) {
		const line = raw.replace(/(^|\s)#.*$/, "").trimEnd();
		if (line.trim() === "") continue;
		const lead = line.length - line.trimStart().length;
		const item = /^-\s+["']?([^"'\s]+)["']?$/.exec(line.trim());
		if (item) {
			while (keys.length > 0 && keys[keys.length - 1].indent > lead) keys.pop();
			if (keys.map((k) => k.name).join(".") === target) scopes.push(item[1]);
			continue;
		}
		const key = /^([\w.-]+):/.exec(line.trim());
		if (!key) continue;
		while (keys.length > 0 && keys[keys.length - 1].indent >= lead) keys.pop();
		keys.push({ name: key[1], indent: lead });
		if (keys.map((k) => k.name).join(".") === target) found = true;
	}
	if (!found) throw new Error(`check-marketplace: ${file} has no ${target} list`);
	return scopes;
}

const problems = [];

/** Records the items only in want (missing from the doc) and only in have (extra in the doc). */
function compare(what, want, have) {
	const missing = want.filter((item) => !have.includes(item));
	const extra = have.filter((item) => !want.includes(item));
	for (const item of missing) problems.push(`${what}: missing from the doc: ${item}`);
	for (const item of extra) problems.push(`${what}: in the doc but not the manifest: ${item}`);
}

function read(path) {
	return readFileSync(path, "utf8");
}

const slackDocFile = join(docs, "slack-directory.md");
const githubDocFile = join(docs, "github-listing.md");
const slackDoc = read(slackDocFile);
const githubDoc = read(githubDocFile);

const scopeRows = tableRows(section(slackDoc, slackDocFile, "Bot scopes"));
compare(
	`Slack bot scopes (${slackManifest})`,
	slackBotScopes(read(slackManifest), slackManifest),
	scopeRows.map((row) => unquote(row[0])),
);

const app = JSON.parse(read(githubManifest));
const rows = tableRows(section(githubDoc, githubDocFile, "Permissions and events"));
const permissionRows = rows.filter((row) => row[0] === "Permission");
const eventRows = rows.filter((row) => row[0] === "Event");
compare(
	`GitHub App permissions (${githubManifest})`,
	Object.entries(app.default_permissions ?? {}).map(([name, access]) => `${name}: ${access}`),
	permissionRows.map((row) => `${unquote(row[1])}: ${row[2]}`),
);
compare(
	`GitHub App events (${githubManifest})`,
	app.default_events ?? [],
	eventRows.map((row) => unquote(row[1])),
);
for (const row of [...permissionRows, ...eventRows]) {
	if (!row[3]) problems.push(`GitHub listing: ${unquote(row[1])} has no justification`);
}

const shortLines = section(githubDoc, githubDocFile, "Short description");
const short = shortLines.find((line) => line.trim() !== "")?.trim() ?? "";
const stated = /\((\d+) characters/.exec(shortLines.join("\n"));
if (short.length > SHORT_MAX) problems.push(`GitHub short description is ${short.length} characters, over ${SHORT_MAX}: ${short}`);
if (!stated || Number(stated[1]) !== short.length) problems.push(`GitHub short description states ${stated ? stated[1] : "no"} characters but has ${short.length}`);

for (const file of [githubDocFile, slackDocFile, join(docs, "checklist.md")]) {
	read(file)
		.split("\n")
		.forEach((line, i) => {
			if (/[\u2013\u2014]/.test(line)) problems.push(`${file}:${i + 1}: en or em dash`);
		});
}

if (problems.length > 0) {
	for (const problem of problems) console.error(`check-marketplace: ${problem}`);
	process.exit(1);
}
