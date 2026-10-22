// The subset of GitHub REST API request and response bodies the hub uses.

/** The only permissions the app requests (plan Q3: read-only plus checks:write). */
export type InstallationPermissionName = "checks" | "contents" | "pull_requests" | "metadata";
export type InstallationPermissions = Partial<Record<InstallationPermissionName, "read" | "write">>;

/** POST /app/installations/{id}/access_tokens request body. */
export interface AccessTokenRequest {
	repository_ids?: number[];
	permissions?: InstallationPermissions;
}

export interface AccessToken {
	token: string;
	/** ISO 8601. */
	expires_at: string;
}

export type RepoPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";

/** GET /repos/{owner}/{repo}/collaborators/{username}/permission. */
export interface CollaboratorPermission {
	/** Legacy base permission; custom roles map onto one of these. */
	permission: "admin" | "write" | "read" | "none";
	/** admin, maintain, write, triage, read, or the name of an organization's custom role. */
	role_name: string;
}

/** GET /orgs/{org}/memberships/{username}. */
export interface OrgMembership {
	state: "active" | "pending";
	role: "admin" | "member" | "billing_manager";
}

export interface Account {
	id: number;
	login: string;
	type: string;
}

export interface Installation {
	id: number;
	app_id: number;
	account: Account | null;
	target_id: number;
	target_type: string;
	permissions: Record<string, string>;
	suspended_at: string | null;
}

export interface User {
	id: number;
	login: string;
	type: string;
	name: string | null;
	email: string | null;
}

export interface Repository {
	id: number;
	name: string;
	full_name: string;
	private: boolean;
	default_branch: string;
	archived: boolean;
	owner: Account;
}

/** GET /repos/{owner}/{repo}/commits/{ref}. */
export interface Commit {
	sha: string;
	commit: {
		message: string;
		author: { name: string; email: string; date: string } | null;
		committer: { name: string; email: string; date: string } | null;
	};
	author: { id: number; login: string } | null;
}

/** One entry of the `files` array GET /repos/{owner}/{repo}/commits/{ref} returns (GitHub lists at most 300). */
export interface CommitFile {
	filename: string;
	additions: number;
	deletions: number;
}

export interface CommitChanges {
	/** Epoch milliseconds, null when GitHub sent no usable date. */
	committedAt: number | null;
	files: CommitFile[];
}

export interface CommitSummary {
	sha: string;
	authorEmail: string | null;
	authorLogin: string | null;
	/** First line of the commit message. */
	title: string;
}

/** GET /repos/{owner}/{repo}/branches/{branch}. */
export interface Branch {
	name: string;
	commit: Commit;
}

export interface BranchHead extends CommitSummary {
	/** Unix ms of the head commit's committer date, or its author date without one. */
	committedAt: number;
}

/** An entry of GET /app/hook/deliveries; each redelivery is its own entry under the same guid. */
export interface HookDelivery {
	id: number;
	/** The X-GitHub-Delivery header value, which the hub records as deliveries.delivery_id. */
	guid: string;
	delivered_at: string;
	redelivery: boolean;
	/** "OK" when the hub answered 2xx. */
	status: string;
	status_code: number;
	event: string;
	action: string | null;
	installation_id: number | null;
	repository_id: number | null;
}

export interface PullRequest {
	number: number;
	state: "open" | "closed";
	draft: boolean;
	title: string;
	user: { id: number; login: string };
	head: { sha: string; ref: string; repo: { id: number; full_name: string; fork: boolean } | null };
	base: { sha: string; ref: string; repo: { id: number; full_name: string } };
}

export type CheckRunStatus = "queued" | "in_progress" | "completed";
export type CheckRunConclusion =
	| "success"
	| "failure"
	| "neutral"
	| "cancelled"
	| "skipped"
	| "timed_out"
	| "action_required";

export interface CheckRunAnnotation {
	path: string;
	start_line: number;
	end_line: number;
	start_column?: number;
	end_column?: number;
	annotation_level: "notice" | "warning" | "failure";
	message: string;
	title?: string;
	raw_details?: string;
}

export interface CheckRunOutput {
	title: string;
	summary: string;
	text?: string;
	/** At most 50 per request. */
	annotations?: CheckRunAnnotation[];
}

/** A requested_action button on the check run page. */
export interface CheckRunAction {
	label: string;
	description: string;
	identifier: string;
}

/** POST /repos/{owner}/{repo}/check-runs. */
export interface CreateCheckRunBody {
	name: string;
	head_sha: string;
	status?: CheckRunStatus;
	conclusion?: CheckRunConclusion;
	external_id?: string;
	details_url?: string;
	started_at?: string;
	completed_at?: string;
	output?: CheckRunOutput;
	actions?: CheckRunAction[];
}

/** PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}. */
export type UpdateCheckRunBody = Partial<Omit<CreateCheckRunBody, "head_sha">>;

export interface CheckRun {
	id: number;
	name: string;
	head_sha: string;
	status: CheckRunStatus;
	conclusion: CheckRunConclusion | null;
	external_id: string | null;
	html_url: string;
}
