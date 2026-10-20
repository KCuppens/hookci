import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { packageRoot } from "../../cli/package.js";
import { readTemplate, renderWranglerToml } from "../../cli/render.js";

type Toml = Record<string, any>;

const root = packageRoot();
const hosted = parse(await readFile(join(root, "wrangler.toml"), "utf8")) as Toml;
const selfHosted = parse(
	renderWranglerToml(await readTemplate(root), {
		name: "zeroci-hub",
		accountId: "00000000000000000000000000000000",
		d1DatabaseId: "00000000-0000-0000-0000-000000000000",
		r2Bucket: "zeroci-hub-logs",
		baseUrl: "https://zeroci-hub.workers.dev",
		hubVersion: "0.0.0",
	}),
) as Toml;

const names = (entries: Toml[] | undefined, key: string): string[] => (entries ?? []).map((e) => e[key]).sort();

// The self-hosted template must offer the Worker every binding and Durable
// Object migration the hosted config does, or a self-hosted deploy breaks.
describe("self-hosted template matches hub/wrangler.toml", () => {
	it("has every Durable Object binding with the same class", () => {
		const pairs = (t: Toml) => (t.durable_objects?.bindings ?? []).map((b: Toml) => `${b.name}=${b.class_name}`).sort();
		expect(pairs(hosted).length).toBeGreaterThan(0);
		expect(pairs(selfHosted)).toEqual(expect.arrayContaining(pairs(hosted)));
	});

	it("has every D1 and R2 binding", () => {
		expect(names(selfHosted.d1_databases, "binding")).toEqual(expect.arrayContaining(names(hosted.d1_databases, "binding")));
		expect(names(selfHosted.r2_buckets, "binding")).toEqual(expect.arrayContaining(names(hosted.r2_buckets, "binding")));
	});

	it("has every Durable Object migration tag with the same classes", () => {
		expect(selfHosted.migrations).toEqual(expect.arrayContaining(hosted.migrations));
	});

	it("uses the same runtime, crons and module rules", () => {
		expect(selfHosted.compatibility_date).toBe(hosted.compatibility_date);
		expect(selfHosted.compatibility_flags).toEqual(hosted.compatibility_flags);
		expect(selfHosted.triggers).toEqual(hosted.triggers);
		expect(selfHosted.rules).toEqual(hosted.rules);
	});
});
