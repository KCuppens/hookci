// Turns GitHub pull_request and push webhook payloads into the hub's trigger,
// the one shape routing, the AgentDO and the sinks work with.

import type { BindingTarget } from "../db/bindings";
import { HubError } from "../errors";

export interface HubTrigger {
	installationId: number;
	repoId: number;
	/** owner/name */
	repo: string;
	sha: string;
	ref: string;
	event: "pull_request" | "push";
	pr?: { number: number; headRef: string; baseRef: string; headRepoFullName: string; fork: boolean; authorLogin: string };
	baseSha?: string;
	authorLogin: string;
	authorEmail?: string;
	commitTitle: string;
	defaultBranch: string;
	target: BindingTarget;
}

const PR_ACTIONS: Record<string, true> = { opened: true, synchronize: true, reopened: true, ready_for_review: true };
const BRANCH_PREFIX = "refs/heads/";
const ZERO_SHA = /^0+$/;

type Json = Record<string, unknown>;

function invalid(path: string): HubError {
	return new HubError("webhook_payload_invalid", 400, `webhook payload field ${path} is missing or mistyped`);
}

function record(v: unknown, path: string): Json {
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw invalid(path);
	return v as Json;
}

function text(v: unknown, path: string): string {
	if (typeof v !== "string") throw invalid(path);
	return v;
}

function int(v: unknown, path: string): number {
	if (!Number.isSafeInteger(v)) throw invalid(path);
	return v as number;
}

/**
 * The trigger a webhook asks for, or null when the event starts no run:
 * pull_request actions other than opened, synchronize, reopened and
 * ready_for_review; branch deletions, tag pushes and pushes without commits.
 * Which branches run is the repo's `.hookci.yml` call (policy/repo-config).
 */
export function normalize(event: string, payload: unknown): HubTrigger | null {
	if (event === "pull_request") return normalizePullRequest(record(payload, "payload"));
	if (event === "push") return normalizePush(record(payload, "payload"));
	return null;
}

function normalizePullRequest(p: Json): HubTrigger | null {
	if (!PR_ACTIONS[text(p.action, "action")]) return null;
	const pr = record(p.pull_request, "pull_request");
	const head = record(pr.head, "pull_request.head");
	const base = record(pr.base, "pull_request.base");
	const repo = record(p.repository, "repository");
	const number = int(pr.number, "pull_request.number");
	// head.repo is null once the fork is deleted; an unknown head counts as a fork.
	const headRepoFullName = head.repo === null ? "" : text(record(head.repo, "pull_request.head.repo").full_name, "pull_request.head.repo.full_name");
	const baseRepoFullName = text(record(base.repo, "pull_request.base.repo").full_name, "pull_request.base.repo.full_name");
	const authorLogin = text(record(pr.user, "pull_request.user").login, "pull_request.user.login");
	return {
		installationId: int(record(p.installation, "installation").id, "installation.id"),
		repoId: int(repo.id, "repository.id"),
		repo: text(repo.full_name, "repository.full_name"),
		sha: text(head.sha, "pull_request.head.sha"),
		ref: `refs/pull/${number}/head`,
		event: "pull_request",
		pr: {
			number,
			headRef: text(head.ref, "pull_request.head.ref"),
			baseRef: text(base.ref, "pull_request.base.ref"),
			headRepoFullName,
			fork: headRepoFullName !== baseRepoFullName,
			authorLogin,
		},
		baseSha: text(base.sha, "pull_request.base.sha"),
		authorLogin,
		commitTitle: text(pr.title, "pull_request.title"),
		defaultBranch: text(repo.default_branch, "repository.default_branch"),
		target: "checks",
	};
}

function normalizePush(p: Json): HubTrigger | null {
	if (p.deleted === true) return null;
	const ref = text(p.ref, "ref");
	if (!ref.startsWith(BRANCH_PREFIX)) return null;
	if (!Array.isArray(p.commits) || p.commits.length === 0) return null;
	const repo = record(p.repository, "repository");
	const defaultBranch = text(repo.default_branch, "repository.default_branch");
	const head = record(p.head_commit, "head_commit");
	const author = record(head.author, "head_commit.author");
	const before = text(p.before, "before");
	return {
		installationId: int(record(p.installation, "installation").id, "installation.id"),
		repoId: int(repo.id, "repository.id"),
		repo: text(repo.full_name, "repository.full_name"),
		sha: text(p.after, "after"),
		ref,
		event: "push",
		baseSha: ZERO_SHA.test(before) ? undefined : before,
		authorLogin: typeof author.username === "string" && author.username !== "" ? author.username : text(record(p.sender, "sender").login, "sender.login"),
		authorEmail: typeof author.email === "string" && author.email !== "" ? author.email : undefined,
		commitTitle: text(head.message, "head_commit.message").split("\n", 1)[0] ?? "",
		defaultBranch,
		target: "checks",
	};
}
