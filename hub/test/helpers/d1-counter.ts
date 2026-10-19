// A D1 wrapper that sums meta.rows_written per statement, for the security
// suites (forged requests write nothing but ip_rate) and the per-run D1 budget.

export interface CountingD1 {
  /** Use in place of the real binding: `env.DB = counter.db`. */
  db: D1Database;
  /** Rows written since the last reset. */
  total(): number;
  /** Rows written since the last reset, by the table each statement writes. */
  byTable(): Record<string, number>;
  reset(): void;
}

// The table a writing statement targets: the first after INSERT [OR x] INTO,
// REPLACE INTO, UPDATE [OR x] or DELETE FROM. D1's rows_written counts every
// index entry written as well as the row, as D1 bills it.
const WRITE_TARGET = /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(\w+)/i;

// Methods the hub never calls; they would bypass the count.
const UNCOUNTED: Record<string, true> = { raw: true, exec: true, withSession: true, dump: true };

function refuseUncounted(prop: string | symbol): void {
  if (typeof prop === "string" && UNCOUNTED[prop]) throw new Error(`countingD1 does not count ${prop}()`);
}

export function countingD1(inner: D1Database): CountingD1 {
  const rows = new Map<string, number>();
  // Each wrapped statement's real statement, which batch() needs, and its SQL.
  const unwrap = new WeakMap<D1PreparedStatement, { stmt: D1PreparedStatement; sql: string }>();

  const count = (sql: string, meta: D1Meta): void => {
    if (meta.rows_written === 0) return;
    const table = WRITE_TARGET.exec(sql)?.[1]?.toLowerCase() ?? "(unknown)";
    rows.set(table, (rows.get(table) ?? 0) + meta.rows_written);
  };

  const wrap = (sql: string, stmt: D1PreparedStatement): D1PreparedStatement => {
    const counted: D1PreparedStatement = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(sql, target.bind(...values));
        if (prop === "run" || prop === "all") {
          return async () => {
            const result = await (prop === "run" ? target.run() : target.all());
            count(sql, result.meta);
            return result;
          };
        }
        // first() reports no meta, and RETURNING writes go through it; read with all() instead.
        if (prop === "first") {
          return async (column?: string) => {
            const { results, meta } = await target.all<Record<string, unknown>>();
            count(sql, meta);
            const row = results[0] ?? null;
            return column === undefined ? row : (row?.[column] ?? null);
          };
        }
        refuseUncounted(prop);
        return Reflect.get(target, prop, target);
      },
    });
    unwrap.set(counted, { stmt, sql });
    return counted;
  };

  const db: D1Database = new Proxy(inner, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(sql, target.prepare(sql));
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const real = statements.map((s) => unwrap.get(s) ?? { stmt: s, sql: "" });
          const results = await target.batch(real.map((r) => r.stmt));
          results.forEach((result, i) => count(real[i]?.sql ?? "", result.meta));
          return results;
        };
      }
      refuseUncounted(prop);
      return Reflect.get(target, prop, target);
    },
  });

  return {
    db,
    total: () => [...rows.values()].reduce((sum, n) => sum + n, 0),
    byTable: () => Object.fromEntries([...rows].sort(([a], [b]) => a.localeCompare(b))),
    reset: () => rows.clear(),
  };
}
