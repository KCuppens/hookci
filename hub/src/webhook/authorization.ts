// GitHub `github_app_authorization` webhook. On revoked, the GitHub user no
// longer trusts the app: their Slack links go in every team, and every
// feature holding per-user state (as fork approvals) cleans up through a hook.

import { deleteUserLinksByGithubId } from "../db/workspaces";
import type { Env } from "../env";
import { deleteApprovalsByUser } from "../forks/approvals";
import { registerHandler } from "./handlers";

export type RevokeHook = (env: Env, githubUserId: number) => Promise<unknown>;

const revokeHooks: RevokeHook[] = [];

/** Runs fn with the GitHub user id each time a user revokes the app, after their links are gone. Register at import time. */
export function registerRevokeHook(fn: RevokeHook): void {
	revokeHooks.push(fn);
}

registerRevokeHook(deleteApprovalsByUser);

/** Deletes every user_links row of the GitHub user, in every team, then runs the revoke hooks in registration order. */
export async function onAuthorizationRevoked(env: Env, githubUserId: number): Promise<void> {
	await deleteUserLinksByGithubId(env.DB, githubUserId);
	for (const hook of revokeHooks) await hook(env, githubUserId);
}

registerHandler("github_app_authorization", async (env, payload) => {
	if (typeof payload !== "object" || payload === null || !("action" in payload) || !("sender" in payload)) {
		return { status: "dropped", note: "malformed_payload" };
	}
	const { action, sender } = payload;
	const senderId = typeof sender === "object" && sender !== null && "id" in sender ? sender.id : undefined;
	if (typeof action !== "string" || typeof senderId !== "number" || !Number.isSafeInteger(senderId)) {
		return { status: "dropped", note: "malformed_payload" };
	}
	if (action === "revoked") await onAuthorizationRevoked(env, senderId);
	return { status: "processed" };
});
