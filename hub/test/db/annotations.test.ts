import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { countRunAnnotations, insertAnnotations, listRunAnnotations, validAnnotations, type ValidAnnotation } from "../../src/db/annotations";
import { purgeInstallation } from "../../src/db/installations";
import { tenantDb } from "../../src/db/tenant";
import { QUOTAS } from "../../src/quotas";
import { seedTenant, type Tenant } from "../helpers/tenants";
import { clearTables } from "./helpers";

let a: Tenant;
let b: Tenant;

beforeEach(async () => {
  await clearTables();
  a = await seedTenant(env, { installationId: 1, teamId: "T1" });
  b = await seedTenant(env, { installationId: 2, teamId: "T2" });
  // seedTenant stores one annotation each; these tests count from zero.
  await env.DB.prepare("DELETE FROM annotations").run();
});

function items(n: number, over: Partial<ValidAnnotation> = {}): ValidAnnotation[] {
  return Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.go`, line: i + 1, level: "warning", message: `m${i}`, ...over }));
}

function store(t: Tenant, job: string, list: ValidAnnotation[]): Promise<number> {
  return insertAnnotations(tenantDb(env.DB, t.installationId), t.runId, job, list, 1_000);
}

describe("validAnnotations", () => {
  it("keeps well formed items and drops the rest", () => {
    const good = { path: "a.go", line: 4, level: "failure", message: "boom", title: "vet" };
    const kept = validAnnotations([
      good,
      { path: "", line: 1, level: "notice", message: "x" },
      { path: "a.go", line: 0, level: "notice", message: "x" },
      { path: "a.go", line: 1.5, level: "notice", message: "x" },
      { path: "a.go", line: 10_000_001, level: "notice", message: "x" },
      { path: "a.go", line: 1, level: "error", message: "x" },
      { path: "a.go", line: 1, level: "constructor", message: "x" },
      { path: "a.go", line: 1, level: "notice", message: 5 },
      { path: 7, line: 1, level: "notice", message: "x" },
      null,
      "text",
    ]);
    expect(kept).toEqual([good]);
  });

  it("returns nothing for a value that is not a list", () => {
    expect(validAnnotations(undefined)).toEqual([]);
    expect(validAnnotations({ length: 1 })).toEqual([]);
    expect(validAnnotations("x")).toEqual([]);
  });
});

describe("insertAnnotations", () => {
  it("stores the fields as sent, with the line as both ends of the range", async () => {
    expect(await store(a, "lint", [{ path: "src/a.ts", line: 3, level: "failure", message: "unused", title: "no-unused" }, ...items(1)])).toBe(2);
    expect(await listRunAnnotations(env.DB, a.installationId, a.runId)).toEqual([
      {
        id: expect.any(Number),
        installation_id: a.installationId,
        run_id: a.runId,
        job: "lint",
        level: "failure",
        path: "src/a.ts",
        start_line: 3,
        end_line: 3,
        title: "no-unused",
        message: "unused",
        created_at: 1_000,
      },
      expect.objectContaining({ level: "warning", title: null }),
    ]);
  });

  it("cuts an oversized path, title, message and job to their limits", async () => {
    const huge = "é".repeat(5000);
    await store(a, huge, [{ path: huge, line: 1, level: "notice", message: huge, title: huge }]);
    const [row] = await listRunAnnotations(env.DB, a.installationId, a.runId);
    expect(Array.from(row?.path ?? "")).toHaveLength(QUOTAS.storedAnnotationPathChars);
    expect(Array.from(row?.message ?? "")).toHaveLength(QUOTAS.storedAnnotationMessageChars);
    expect(Array.from(row?.title ?? "")).toHaveLength(QUOTAS.storedAnnotationTitleChars);
    expect(Array.from(row?.job ?? "")).toHaveLength(QUOTAS.storedAnnotationTitleChars);
    expect(row?.message).toBe("é".repeat(QUOTAS.storedAnnotationMessageChars));
  });

  it("keeps the first 50 of a job", async () => {
    expect(await store(a, "lint", items(80))).toBe(QUOTAS.storedAnnotationsPerJob);
    expect(await store(a, "lint", items(5))).toBe(0);
    expect((await countRunAnnotations(env.DB, a.installationId, a.runId)).total).toBe(50);
    const stored = await listRunAnnotations(env.DB, a.installationId, a.runId);
    expect(stored.map((r) => r.message)).toContain("m49");
    expect(stored.map((r) => r.message)).not.toContain("m50");
  });

  it("keeps at most 200 for a run across jobs and stores what still fits", async () => {
    for (const job of ["j1", "j2", "j3"]) expect(await store(a, job, items(50))).toBe(50);
    expect(await store(a, "j4", items(30))).toBe(30);
    expect(await store(a, "j5", items(50))).toBe(20);
    expect(await store(a, "j6", items(1))).toBe(0);
    expect((await countRunAnnotations(env.DB, a.installationId, a.runId)).total).toBe(QUOTAS.storedAnnotationsPerRun);
  });

  it("stores nothing for an empty list", async () => {
    expect(await store(a, "lint", [])).toBe(0);
  });

  it("keeps every character of a message that holds quotes and JSON", async () => {
    const message = `{"a": ["b", 'c'], \\n} ${"\u{1F600}"} ?1 ; DROP TABLE annotations`;
    await store(a, "lint", [{ path: "a'b\"c.go", line: 1, level: "notice", message }]);
    const [row] = await listRunAnnotations(env.DB, a.installationId, a.runId);
    expect(row).toMatchObject({ path: "a'b\"c.go", message });
  });
});

describe("listRunAnnotations", () => {
  it("lists failures, then warnings, then notices, each by path and line", async () => {
    await store(a, "lint", [
      { path: "b.go", line: 2, level: "notice", message: "n-b2" },
      { path: "b.go", line: 1, level: "warning", message: "w-b1" },
      { path: "z.go", line: 9, level: "failure", message: "f-z9" },
      { path: "a.go", line: 20, level: "warning", message: "w-a20" },
      { path: "a.go", line: 3, level: "warning", message: "w-a3" },
      { path: "a.go", line: 3, level: "failure", message: "f-a3" },
      { path: "a.go", line: 1, level: "notice", message: "n-a1" },
    ]);
    const rows = await listRunAnnotations(env.DB, a.installationId, a.runId);
    expect(rows.map((r) => r.message)).toEqual(["f-a3", "f-z9", "w-a3", "w-a20", "w-b1", "n-a1", "n-b2"]);
  });

  it("returns nothing for a run without annotations", async () => {
    expect(await listRunAnnotations(env.DB, a.installationId, a.runId)).toEqual([]);
  });
});

describe("countRunAnnotations", () => {
  it("counts by level and totals them", async () => {
    await store(a, "lint", [...items(3, { level: "failure" }), ...items(2, { level: "warning" }), ...items(4, { level: "notice" })]);
    expect(await countRunAnnotations(env.DB, a.installationId, a.runId)).toEqual({ failure: 3, warning: 2, notice: 4, total: 9 });
  });

  it("counts zero for a run without annotations", async () => {
    expect(await countRunAnnotations(env.DB, a.installationId, a.runId)).toEqual({ failure: 0, warning: 0, notice: 0, total: 0 });
  });
});

describe("tenant isolation", () => {
  it("never shows installation A's annotations to installation B", async () => {
    await store(a, "lint", items(3));
    await store(b, "lint", items(1, { message: "b only" }));

    expect(await listRunAnnotations(env.DB, b.installationId, a.runId)).toEqual([]);
    expect(await countRunAnnotations(env.DB, b.installationId, a.runId)).toMatchObject({ total: 0 });
    expect((await listRunAnnotations(env.DB, b.installationId, b.runId)).map((r) => r.message)).toEqual(["b only"]);
    expect(await listRunAnnotations(env.DB, a.installationId, b.runId)).toEqual([]);
  });

  it("stores nothing when installation B names installation A's run", async () => {
    await store(a, "lint", items(2));
    expect(await insertAnnotations(tenantDb(env.DB, b.installationId), a.runId, "lint", items(5), 1)).toBe(0);
    expect(await listRunAnnotations(env.DB, a.installationId, a.runId)).toHaveLength(2);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM annotations WHERE installation_id = ?1").bind(b.installationId).first<{ n: number }>())?.n).toBe(0);
  });

  it("stores nothing for a run that does not exist", async () => {
    expect(await insertAnnotations(tenantDb(env.DB, a.installationId), "run-nope", "lint", items(2), 1)).toBe(0);
  });
});

describe("purge", () => {
  it("removes the installation's annotations and leaves the other installation's", async () => {
    await store(a, "lint", items(3));
    await store(b, "lint", items(2));
    await purgeInstallation(env.DB, a.installationId);
    expect(await listRunAnnotations(env.DB, a.installationId, a.runId)).toEqual([]);
    expect(await listRunAnnotations(env.DB, b.installationId, b.runId)).toHaveLength(2);
  });
});
