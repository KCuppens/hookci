import { getInstallation } from "./installations";
import type { TenantDb } from "./tenant";

/** How many repository names the installed page lists before "+ N more". */
export const PROGRESS_REPO_NAMES = 5;

/** Which onboarding steps an installation has already finished, and the repositories GitHub granted it. */
export interface InstallProgress {
	agentOnline: boolean;
	/** A run has produced at least one job besides the `_config` check. */
	configured: boolean;
	bound: boolean;
	slackLinked: boolean;
	repoCount: number;
	/** Whether GitHub granted all repositories or a selection; null until GitHub has reported it. */
	repoSelection: "all" | "selected" | null;
	/** The first repositories by name, at most PROGRESS_REPO_NAMES. */
	repoNames: string[];
}

interface Counts {
	agents: number;
	jobs: number;
	bindings: number;
	slack: number;
	repos: number;
}

export async function installProgress(t: TenantDb): Promise<InstallProgress> {
	const counts = await t.first<Counts>(
		`SELECT
			(SELECT COUNT(*) FROM agents WHERE installation_id = ?1 AND status = 'online') AS agents,
			(SELECT COUNT(*) FROM jobs WHERE name != '_config' AND run_id IN (SELECT run_id FROM runs WHERE installation_id = ?1)) AS jobs,
			(SELECT COUNT(*) FROM repo_bindings WHERE installation_id = ?1) AS bindings,
			(SELECT COUNT(*) FROM workspace_links WHERE installation_id = ?1) AS slack,
			(SELECT COUNT(*) FROM repos WHERE installation_id = ?1) AS repos`,
	);
	const names = await t.all<{ full_name: string }>(
		"SELECT full_name FROM repos WHERE installation_id = ?1 ORDER BY full_name COLLATE NOCASE LIMIT ?2",
		PROGRESS_REPO_NAMES,
	);
	const installation = await getInstallation(t.db, t.installationId);
	return {
		agentOnline: (counts?.agents ?? 0) > 0,
		configured: (counts?.jobs ?? 0) > 0,
		bound: (counts?.bindings ?? 0) > 0,
		slackLinked: (counts?.slack ?? 0) > 0,
		repoCount: counts?.repos ?? 0,
		repoSelection: installation?.repository_selection ?? null,
		repoNames: names.map((n) => n.full_name),
	};
}
