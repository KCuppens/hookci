#!/usr/bin/env node
// Writes the dev and staging GitHub and Slack App manifests in
// hub/manifests/generated/<env>/ from the production ones in hub/manifests/,
// replacing the host, the app name and the slash command.
// With --check it writes nothing and exits 1 when a committed file differs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const manifests = join(dirname(fileURLToPath(import.meta.url)), "..", "hub", "manifests");
const PROD_HOST = "https://ci.hookci.com";

const ENVIRONMENTS = {
	dev: { host: "https://DEV-TUNNEL.example", name: "hookci-dev" },
	staging: { host: "https://ci-staging.hookci.com", name: "hookci-staging" },
};

// Each pattern must match in the production manifest, so a renamed key fails loudly instead of leaking production values.
function replaceAll(text, file, rules) {
	let out = text;
	for (const [pattern, replacement] of rules) {
		if (!pattern.test(out)) throw new Error(`gen-manifests: ${file}: no match for ${pattern}`);
		out = out.replace(pattern, replacement);
	}
	return out;
}

function render(file, { host, name }) {
	const text = readFileSync(join(manifests, file), "utf8");
	const rules =
		file === "github-app.json"
			? [[/"name": "hookci"/g, `"name": "${name}"`]]
			: [
					[/^  name: hookci$/gm, `  name: ${name}`],
					[/^    display_name: hookci$/gm, `    display_name: ${name}`],
					[/^    - command: \/hookci$/gm, `    - command: /${name}`],
				];
	return replaceAll(text, file, [[new RegExp(PROD_HOST.replaceAll(".", "\\."), "g"), host], ...rules]);
}

const check = process.argv.includes("--check");
let stale = 0;
for (const [envName, vars] of Object.entries(ENVIRONMENTS)) {
	const dir = join(manifests, "generated", envName);
	for (const file of ["github-app.json", "slack-app.yml"]) {
		const want = render(file, vars);
		const path = join(dir, file);
		if (check) {
			let have = null;
			try {
				have = readFileSync(path, "utf8");
			} catch {}
			if (have !== want) {
				console.error(`gen-manifests: ${path} is stale; run node scripts/gen-manifests.mjs`);
				stale++;
			}
			continue;
		}
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, want);
	}
}
if (stale > 0) process.exit(1);
