import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packageRoot, packageVersion } from "../../cli/package.js";
import { scriptedPrompter } from "../../cli/prompts.js";
import { type RenderInput, readTemplate, renderStateDir, renderWranglerToml } from "../../cli/render.js";
import { saveState } from "../../cli/state.js";

const input: RenderInput = {
	name: "acme-hub",
	accountId: "0123456789abcdef0123456789abcdef",
	d1DatabaseId: "11111111-2222-3333-4444-555555555555",
	r2Bucket: "acme-hub-logs",
	baseUrl: "https://acme-hub.acme.workers.dev",
	hubVersion: "1.2.3",
};

type Toml = Record<string, any>;

describe("renderWranglerToml", () => {
	it("renders TOML that parses, in self_hosted mode, with every value in place", async () => {
		const text = renderWranglerToml(await readTemplate(), input);
		expect(text).toContain('HUB_MODE = "self_hosted"');
		const toml = parse(text) as Toml;
		expect(toml.name).toBe("acme-hub");
		expect(toml.account_id).toBe(input.accountId);
		expect(toml.main).toBe("worker/index.js");
		expect(toml.no_bundle).toBe(true);
		expect(toml.vars).toMatchObject({
			HUB_MODE: "self_hosted",
			HUB_ORIGIN: input.baseUrl,
			HUB_VERSION: "1.2.3",
			GITHUB_API_URL: "https://api.github.com",
			SECURITY_CONTACT: "",
			TELEGRAM_API_BASE: "https://api.telegram.org",
		});
		expect(toml.d1_databases).toEqual([{ binding: "DB", database_name: "acme-hub-db", database_id: input.d1DatabaseId, migrations_dir: "migrations" }]);
		expect(toml.r2_buckets).toEqual([{ binding: "LOGS", bucket_name: "acme-hub-logs" }]);
		expect(text).not.toMatch(/\{\{/);
	});

	it("adds a custom_domain route only when customDomain is set", async () => {
		const tmpl = await readTemplate();
		expect(parse(renderWranglerToml(tmpl, input)).routes).toBeUndefined();
		const toml = parse(renderWranglerToml(tmpl, { ...input, customDomain: "ci.acme.dev" })) as Toml;
		expect(toml.routes).toEqual([{ pattern: "ci.acme.dev", custom_domain: true }]);
	});

	it("uses the given GitHub API URL and security contact", async () => {
		const toml = parse(
			renderWranglerToml(await readTemplate(), { ...input, githubApiUrl: "https://ghe.acme.dev/api/v3", securityContact: "mailto:sec@acme.dev" }),
		) as Toml;
		expect(toml.vars.GITHUB_API_URL).toBe("https://ghe.acme.dev/api/v3");
		expect(toml.vars.SECURITY_CONTACT).toBe("mailto:sec@acme.dev");
	});

	it("escapes quotes and backslashes so values cannot break out of their string", async () => {
		const toml = parse(renderWranglerToml(await readTemplate(), { ...input, baseUrl: 'https://x.dev/"\\\nevil = 1' })) as Toml;
		expect(toml.vars.HUB_ORIGIN).toBe('https://x.dev/"\\\nevil = 1');
		expect(toml.evil).toBeUndefined();
	});

	it("throws listing every placeholder without a value", async () => {
		const tmpl = await readTemplate();
		expect(() => renderWranglerToml(tmpl, { ...input, accountId: "", d1DatabaseId: "" })).toThrow(
			"wrangler template has no value for {{accountId}}, {{d1DatabaseId}}",
		);
		expect(() => renderWranglerToml(`${tmpl}\nx = "{{unknownThing}}"\n`, input)).toThrow("{{unknownThing}}");
	});
});

describe("renderStateDir", () => {
	let tmp: string;
	let root: string;
	let dir: string;

	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "zeroci-hub-render-"));
		root = join(tmp, "pkg");
		dir = join(tmp, "state");
		await mkdir(join(root, "templates"), { recursive: true });
		await mkdir(join(root, "dist", "worker"), { recursive: true });
		await mkdir(join(root, "migrations"), { recursive: true });
		await writeFile(join(root, "templates", "wrangler.self-hosted.toml.tmpl"), await readTemplate(packageRoot()));
		await writeFile(join(root, "dist", "worker", "index.js"), "export default {};\n");
		await writeFile(join(root, "migrations", "0001_init.sql"), "SELECT 1;\n");
	});

	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	it("renders placeholders into a fresh dir and installs the worker and migrations", async () => {
		expect(await renderStateDir(dir, scriptedPrompter({}), root)).toBe(true);
		const toml = parse(await readFile(join(dir, "wrangler.toml"), "utf8")) as Toml;
		expect(toml.account_id).toBe("00000000000000000000000000000000");
		expect(toml.vars.HUB_VERSION).toBe(packageVersion());
		expect(await readFile(join(dir, "worker", "index.js"), "utf8")).toBe("export default {};\n");
		expect(await readFile(join(dir, "migrations", "0001_init.sql"), "utf8")).toBe("SELECT 1;\n");
	});

	it("renders from saved state and replaces a stale bundle", async () => {
		await saveState(dir, {
			account_id: input.accountId,
			d1_database_id: input.d1DatabaseId,
			r2_bucket: "saved-logs",
			base_url: "https://saved.example",
			version: "0.0.1",
			steps_done: ["account"],
		});
		await mkdir(join(dir, "worker"), { recursive: true });
		await writeFile(join(dir, "worker", "stale.js"), "old\n");
		expect(await renderStateDir(dir, scriptedPrompter({}), root)).toBe(true);
		const toml = parse(await readFile(join(dir, "wrangler.toml"), "utf8")) as Toml;
		expect(toml.account_id).toBe(input.accountId);
		expect(toml.d1_databases[0].database_id).toBe(input.d1DatabaseId);
		expect(toml.r2_buckets[0].bucket_name).toBe("saved-logs");
		expect(toml.vars.HUB_ORIGIN).toBe("https://saved.example");
		await expect(readFile(join(dir, "worker", "stale.js"))).rejects.toThrow(/ENOENT/);
	});

	it("leaves a differing wrangler.toml alone when the overwrite is declined", async () => {
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "wrangler.toml"), "# hand edited\n");
		const prompter = scriptedPrompter({ [`Overwrite ${join(dir, "wrangler.toml")}?`]: "n" });
		expect(await renderStateDir(dir, prompter, root)).toBe(false);
		expect(await readFile(join(dir, "wrangler.toml"), "utf8")).toBe("# hand edited\n");
	});

	it("fails when the package has no prebuilt worker", async () => {
		await rm(join(root, "dist"), { recursive: true });
		await expect(renderStateDir(dir, scriptedPrompter({}), root)).rejects.toThrow("run npm run prepack");
	});
});
