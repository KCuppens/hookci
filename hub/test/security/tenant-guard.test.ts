/// <reference types="vite/client" />
// Installation data is reached through tenantDb, which refuses SQL not scoped
// to `installation_id = ?1`, or through the helpers in src/db/. This guard
// fails when code elsewhere hands SQL naming a tenant table straight to
// .prepare(), where nothing checks the scope.

import { describe, expect, it } from "vitest";

const sources: Record<string, string> = import.meta.glob<string>("../../src/**/*.ts", { query: "?raw", import: "default", eager: true });

const TENANT_TABLES = [
  "runs",
  "jobs",
  "repos",
  "repo_bindings",
  "watches",
  "agents",
  "check_runs",
  "fork_approvals",
  "pair_tokens",
  "daily_counters",
];
const TENANT_REF = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+(${TENANT_TABLES.join("|")})\\b`, "i");

// Unscoped on purpose, keyed `path:sql` so no other query in the file shares
// the entry. Revoking a GitHub user drops their approvals in every
// installation at once. The cron purge needs no entry: it runs through
// src/db/purge.ts and src/db/installations.ts.
const ALLOWED: Record<string, true> = {
  "src/forks/approvals.ts:DELETE FROM fork_approvals WHERE approved_by_github_id = ?1 AND used_at IS NULL": true,
};

interface PrepareCall {
  /** `src/...` path of the file. */
  path: string;
  /** The nearest function declared before the call. */
  fn: string;
  /** The string-literal SQL, or null when the argument is not a literal. */
  sql: string | null;
  /** The tenant table the SQL names, if any. */
  table: string | null;
}

const QUOTES: Record<string, true> = { "`": true, '"': true, "'": true };

/** The string literal opening at text[start], or null when text[start] opens none. */
function literalAt(text: string, start: number): string | null {
  const quote = text[start];
  if (quote === undefined || !QUOTES[quote]) return null;
  let i = start + 1;
  while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
  return text.slice(start + 1, i);
}

/** Every .prepare() call outside src/db/, with the SQL it is given. */
function prepareCalls(files: Record<string, string>): PrepareCall[] {
  return Object.entries(files).flatMap(([file, text]) => {
    const path = file.slice(file.indexOf("src/"));
    if (path.startsWith("src/db/")) return [];
    return [...text.matchAll(/\.prepare\s*\(\s*/g)].map((match) => {
      const sql = literalAt(text, match.index + match[0].length);
      const before = [...text.slice(0, match.index).matchAll(/\b(?:function|async)\s+(\w+)\s*[(<]/g)];
      return { path, fn: before.at(-1)?.[1] ?? "(top level)", sql, table: sql === null ? null : (TENANT_REF.exec(sql)?.[1] ?? null) };
    });
  });
}

/** The calls the guard rejects: tenant SQL, or SQL it cannot read, outside src/db/ and the allow-list. */
function violations(files: Record<string, string>): PrepareCall[] {
  return prepareCalls(files).filter((call) => (call.sql === null || call.table !== null) && !ALLOWED[`${call.path}:${call.sql}`]);
}

describe("tenant guard", () => {
  it("finds no tenant-table SQL passed to .prepare() outside src/db/", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(violations(sources)).toEqual([]);
  });

  it("allows only calls that still exist", () => {
    const used = new Set(prepareCalls(sources).map((call) => `${call.path}:${call.sql}`));
    expect(Object.keys(ALLOWED).filter((key) => !used.has(key))).toEqual([]);
  });

  it("rejects a tenant query outside src/db/", () => {
    const leak = `export async function listEverything(env: Env) {\n  return env.DB.prepare("SELECT * FROM runs").all();\n}\n`;
    expect(violations({ "../../src/routes/leak.ts": leak })).toEqual([
      { path: "src/routes/leak.ts", fn: "listEverything", sql: "SELECT * FROM runs", table: "runs" },
    ]);
  });

  it("rejects tenant writes and joins in template literals, and SQL it cannot read", () => {
    const files = {
      "../../src/a.ts": "function a(db) { return db.prepare(`DELETE FROM\n  pair_tokens WHERE token_hash = ?1`); }",
      "../../src/b.ts": "async function b(db) { await db.prepare('SELECT w.* FROM workspaces w JOIN repo_bindings r ON 1').all(); }",
      "../../src/c.ts": "async function c(db, sql) { await db.prepare(sql).run(); }",
    };
    expect(violations(files).map((call) => [call.fn, call.table])).toEqual([
      ["a", "pair_tokens"],
      ["b", "repo_bindings"],
      ["c", null],
    ]);
  });

  it("passes tenant SQL inside src/db/, global tables anywhere, and the allow-listed revoke", () => {
    const files = {
      "../../src/db/runs.ts": 'export async function all(db) { return db.prepare("SELECT * FROM runs").all(); }',
      "../../src/oauth/state.ts": 'async function take(db) { return db.prepare("UPDATE oauth_states SET used_at = ?1").run(); }',
      "../../src/forks/approvals.ts":
        'export async function deleteApprovalsByUser(env) { await env.DB.prepare("DELETE FROM fork_approvals WHERE approved_by_github_id = ?1 AND used_at IS NULL").run(); }',
    };
    expect(violations(files)).toEqual([]);
  });

  it("does not extend the allow-list to other SQL in the allow-listed file", () => {
    const files = {
      "../../src/forks/approvals.ts": 'export async function deleteApprovalsByUser(env) { await env.DB.prepare("DELETE FROM fork_approvals").run(); }',
    };
    expect(violations(files).map((call) => [call.fn, call.table])).toEqual([["deleteApprovalsByUser", "fork_approvals"]]);
  });
});
