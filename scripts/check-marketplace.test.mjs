// Runs scripts/check-marketplace.mjs against a copy of the repo files it reads,
// with one listing doc or manifest changed per test.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(t, edit, args = []) {
	const dir = mkdtempSync(join(tmpdir(), "check-marketplace-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const path of ["scripts/check-marketplace.mjs", "docs/marketplace", "hub/manifests/slack-app.yml", "hub/manifests/github-app.json"]) {
		cpSync(join(root, path), join(dir, path), { recursive: true });
	}
	const change = (path, from, to) => {
		const text = readFileSync(join(dir, path), "utf8");
		assert.ok(text.includes(from), `${path} lacks ${from}`);
		writeFileSync(join(dir, path), text.replace(from, to));
	};
	edit(change, dir);
	return spawnSync(process.execPath, [join(dir, "scripts/check-marketplace.mjs"), ...args.map((a) => a.replace("$DIR", dir))], { encoding: "utf8" });
}

test("the committed listing docs match the manifests", (t) => {
	const res = run(t, () => {});
	assert.equal(res.stderr, "");
	assert.equal(res.status, 0);
});

test("a scope added to a manifest passed with --slack-manifest fails and is named", (t) => {
	const res = run(
		t,
		(change, dir) => {
			cpSync(join(dir, "hub/manifests/slack-app.yml"), join(dir, "copy.yml"));
			change("copy.yml", "      - users:read.email\n", "      - users:read.email\n      - files:write\n");
		},
		["--slack-manifest", "$DIR/copy.yml"],
	);
	assert.equal(res.status, 1);
	assert.match(res.stderr, /missing from the doc: files:write/);
});

test("a scope row the manifest lacks fails", (t) => {
	const res = run(t, (change) => change("docs/marketplace/slack-directory.md", "| `commands` |", "| `chat:write.public` | Posts anywhere. |\n| `commands` |"));
	assert.equal(res.status, 1);
	assert.match(res.stderr, /in the doc but not the manifest: chat:write\.public/);
});

test("a GitHub permission or event without a row fails", (t) => {
	const res = run(t, (change) => {
		change("hub/manifests/github-app.json", '"checks": "write"', '"checks": "write",\n\t\t"issues": "write"');
		change("hub/manifests/github-app.json", '"push",', '"push",\n\t\t"release",');
	});
	assert.equal(res.status, 1);
	assert.match(res.stderr, /GitHub App permissions .*missing from the doc: issues: write/);
	assert.match(res.stderr, /GitHub App events .*missing from the doc: release/);
});

test("a permission row with the wrong access level fails", (t) => {
	const res = run(t, (change) => change("docs/marketplace/github-listing.md", "| Permission | `checks` | write |", "| Permission | `checks` | read |"));
	assert.equal(res.status, 1);
	assert.match(res.stderr, /missing from the doc: checks: write/);
});

test("a short description over 80 characters fails", (t) => {
	const long = "x".repeat(81);
	const res = run(t, (change) =>
		change("docs/marketplace/github-listing.md", "Run CI on your own machine, with results in GitHub Checks and Slack\n\n(67 characters", `${long}\n\n(81 characters`),
	);
	assert.equal(res.status, 1);
	assert.match(res.stderr, /short description is 81 characters, over 80/);
});

test("an em dash in a listing doc fails", (t) => {
	const res = run(t, (change) => change("docs/marketplace/checklist.md", "Walk this list", "Walk this list \u2014"));
	assert.equal(res.status, 1);
	assert.match(res.stderr, /checklist\.md:\d+: en or em dash/);
});
