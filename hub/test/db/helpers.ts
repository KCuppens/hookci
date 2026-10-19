import { env } from "cloudflare:workers";

/** Tables created by hub/migrations, without SQLite, D1 and migration bookkeeping. */
export async function schemaTables(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations'
      ORDER BY name`,
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

export async function columnsOf(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info(?1)").bind(table).all<{ name: string }>();
  return results.map((r) => r.name);
}

/** Empties every schema table so each test starts from a blank database. */
export async function clearTables(): Promise<void> {
  const tables = await schemaTables();
  await env.DB.batch(tables.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}
