import { HubError } from "../errors";

/**
 * Every table with an installation_id column; purgeInstallation empties each.
 * test/db/tenant-tables.test.ts fails when a migration adds one not listed here.
 */
export const TENANT_TABLES: readonly string[] = [
	"runs",
	"repos",
	"workspace_links",
	"agents",
	"pair_tokens",
	"repo_bindings",
	"watches",
	"check_runs",
	"deliveries",
	"author_cache",
	"author_map",
	"daily_counters",
	"fork_approvals",
	"deploy_triggers",
	"deploy_renders",
	"sink_configs",
	"sink_messages",
	"sink_deliveries",
];

/**
 * D1 access bound to one GitHub installation. Every statement must be scoped
 * to `?1`, which is always the installation id; callers' binds start at `?2`.
 */
export interface TenantDb {
	readonly installationId: number;
	readonly db: D1Database;
	all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
	first<T>(sql: string, ...binds: unknown[]): Promise<T | null>;
	run(sql: string, ...binds: unknown[]): Promise<D1Result>;
}

// `installation_id = ?1` anywhere, which includes the
// `run_id IN (SELECT run_id FROM runs WHERE installation_id = ?1)` form.
const SCOPED_FILTER = /\binstallation_id = \?1(?!\d)/i;
// An INSERT whose first column is installation_id and whose only row (one
// VALUES tuple, or a SELECT) puts ?1 there.
const SCOPED_INSERT =
	/^INSERT (?:OR \w+ )?INTO \w+ ?\(installation_id\b[^)]*\) (?:VALUES ?\(\?1(?!\d)[^()]*\)(?! ?,)|SELECT \?1(?!\d))/i;

/** Whether sql can only touch rows of the installation bound as ?1. */
function isTenantScoped(sql: string): boolean {
	const s = sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/ ?= ?/g, " = ").trim();
	return SCOPED_FILTER.test(s) || SCOPED_INSERT.test(s);
}

export function tenantDb(db: D1Database, installationId: number): TenantDb {
	const prepare = (sql: string, binds: unknown[]): D1PreparedStatement => {
		if (!isTenantScoped(sql)) {
			throw new HubError("tenant_scope_missing", 500, `query not scoped to installation_id = ?1: ${sql.replace(/\s+/g, " ").trim().slice(0, 120)}`);
		}
		return db.prepare(sql).bind(installationId, ...binds);
	};
	return {
		installationId,
		db,
		async all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
			const { results } = await prepare(sql, binds).all<T>();
			return results;
		},
		async first<T>(sql: string, ...binds: unknown[]): Promise<T | null> {
			return prepare(sql, binds).first<T>();
		},
		async run(sql: string, ...binds: unknown[]): Promise<D1Result> {
			return prepare(sql, binds).run();
		},
	};
}
