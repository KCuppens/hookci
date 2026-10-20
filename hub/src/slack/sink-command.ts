// /zeroci sink add|list|remove|test: Slack's side of the sink config service.
// add opens the Add sink modal, whose submission /slack/interactive hands to
// handleSinkAddSubmission. Every command and every submission asks GitHub
// afresh whether the caller is admin or maintain on the repo. Secrets travel
// only through the modal: a command holding a bot token or URL is refused
// before anything reads, stores or logs it.

import { getSinkConfig, type SinkKind } from "../db/sinks";
import { type TenantDb, tenantDb } from "../db/tenant";
import { listLinkedInstallationIds } from "../db/workspaces";
import type { Env } from "../env";
import { HubError } from "../errors";
import { requireLinkedUser } from "../identity/link";
import { reportError } from "../observability";
import {
	addSinkConfig,
	listSinkConfigsForRepo,
	removeSinkConfig,
	type SinkActor,
	SinkConfigError,
	type SinkConfigErrorCode,
	SinkQuotaError,
	sendTestDelivery,
} from "../sinks/config-service";
import type { DeliveryResult } from "../sinks/deliverers";
import { S } from "../strings";
import { slackApi } from "./api";
import { commandArgs, ephemeral } from "./commands/common";
import { registerCommand, type SlackCommandRequest, type SlackReply } from "./registry";
import { requireSinkManager, resolveRepo } from "./resolve";
import { buildSinkAddedModal, buildSinkAddModal, isSlackViewSubmission, parseSinkAddSubmission, SINK_ADD_CALLBACK_ID, type SinkField } from "./sink-modal";
import type { SlackView } from "./views";

/** A Telegram bot token, or a URL such as a webhook's: secrets that must not travel in command text. */
const SECRET_ARGS = [/^\d+:[A-Za-z0-9_-]{30,}$/, /^https:\/\//i];

/** The modal field each refusal of the config service is shown on; invalid is the URL's for a webhook and the label's for Telegram. */
const ERROR_FIELD: Record<Exclude<SinkConfigErrorCode, "invalid">, SinkField> = {
	invalid_repo: "kind",
	repo_not_bound: "kind",
	limit_reached: "kind",
	bad_token: "bot_token",
	chat_unreachable: "chat_id",
	not_https: "webhook_url",
	private_host: "webhook_url",
	self: "webhook_url",
};

/** The expected refusals of a submission, shown on the kind field instead of a reported failure. */
const SUBMIT_REFUSALS: Record<string, string> = {
	not_linked: S.slack.notLinked,
	forbidden: S.slack.forbidden,
	repo_not_found: S.slack.repoNotFound,
	telegram_unreachable: S.slack.sinkTelegramDown,
};

/** What /slack/interactive answers Slack for an Add sink submission. */
export type SinkAddResponse =
	| { response_action: "clear" }
	| { response_action: "errors"; errors: Record<string, string> }
	| { response_action: "update"; view: SlackView };

/** The installation and repo of the sink, searched in the installations linked to the team; null when none has it. */
async function findSink(env: Env, teamId: string, id: string): Promise<{ t: TenantDb; repo: string } | null> {
	for (const installationId of await listLinkedInstallationIds(env.DB, teamId)) {
		const t = tenantDb(env.DB, installationId);
		const sink = await getSinkConfig(t, id);
		if (sink) return { t, repo: sink.repo };
	}
	return null;
}

function testText(id: string, result: DeliveryResult): string {
	if (result.kind === "ok") return S.slack.sinkTestOk(id);
	const detail = result.kind === "fail" && result.disable ? result.disable : result.httpStatus !== undefined ? `HTTP ${result.httpStatus}` : null;
	return result.kind === "retry" ? S.slack.sinkTestRetry(id, detail) : S.slack.sinkTestFail(id, detail);
}

/** Runs `/zeroci sink <args>` for the caller in ctx and answers with an ephemeral reply. */
export async function handleSinkCommand(env: Env, ctx: SlackCommandRequest, args: string[]): Promise<SlackReply> {
	const [sub, ref, ...rest] = args;
	if (args.slice(1).some((arg) => SECRET_ARGS.some((secret) => secret.test(arg)))) return ephemeral(S.slack.sinkSecretInCommand);
	const user = await requireLinkedUser(env, ctx.teamId, ctx.userId);
	if (ref === undefined || rest.length > 0) return ephemeral(S.slack.usage(S.slack.sinkUsage));

	if (sub === "add" || sub === "list") {
		const repo = await resolveRepo(env, ctx.teamId, ref);
		await requireSinkManager(env, repo.installationId, repo.fullName, user.githubLogin);
		if (sub === "add") {
			await slackApi(env, ctx.teamId, "views.open", { trigger_id: ctx.triggerId, view: buildSinkAddModal(repo.fullName, ctx.channelId) });
			return ephemeral(S.slack.sinkFormOpened(repo.fullName));
		}
		const sinks = await listSinkConfigsForRepo(tenantDb(env.DB, repo.installationId), repo.fullName);
		if (sinks.length === 0) return ephemeral(S.slack.sinkNone(repo.fullName));
		const lines = sinks.map((sink) => S.slack.sinkListItem(sink.id, S.slack.sinkKind[sink.kind], sink.target, sink.label, sink.last_error));
		return ephemeral([S.slack.sinkListHeader(repo.fullName), ...lines].join("\n"));
	}

	if (sub === "remove" || sub === "test") {
		const found = await findSink(env, ctx.teamId, ref);
		if (!found) return ephemeral(S.slack.sinkNotFound(ref));
		await requireSinkManager(env, found.t.installationId, found.repo, user.githubLogin);
		const actor: SinkActor = { type: "slack_user", id: `${ctx.teamId}:${ctx.userId}` };
		try {
			if (sub === "test") return ephemeral(testText(ref, await sendTestDelivery(env, found.t, actor, ref)));
			const removed = await removeSinkConfig(env, found.t, actor, ref);
			return ephemeral(removed ? S.slack.sinkRemoved(ref, found.repo) : S.slack.sinkNotFound(ref));
		} catch (err) {
			if (err instanceof SinkQuotaError) return ephemeral(S.slack.sinkQuota(Math.ceil(err.retryAfterSeconds / 60)));
			if (err instanceof HubError && err.code === "not_found") return ephemeral(S.slack.sinkNotFound(ref));
			throw err;
		}
	}

	return ephemeral(S.slack.usage(S.slack.sinkUsage));
}

/** The field errors of a refused submission; an unexpected failure is reported and shown on the kind field. */
function submitErrors(err: unknown, teamId: string, kind: SinkKind | undefined): Record<string, string> {
	if (err instanceof SinkConfigError) {
		const field = err.code === "invalid" ? (kind === "telegram" ? "label" : "webhook_url") : ERROR_FIELD[err.code];
		return { [field]: err.message };
	}
	if (err instanceof SinkQuotaError) return { kind: S.slack.sinkQuota(Math.ceil(err.retryAfterSeconds / 60)) };
	if (err instanceof HubError && Object.hasOwn(SUBMIT_REFUSALS, err.code)) return { kind: SUBMIT_REFUSALS[err.code] ?? S.slack.failed };
	reportError(err, { team_id: teamId, callback_id: SINK_ADD_CALLBACK_ID });
	return { kind: S.slack.failed };
}

/**
 * Adds the sink a submitted Add sink modal describes, after checking afresh
 * that the submitter is linked and admin or maintain on the repo. Refusals
 * come back as field errors in the modal. On success the result, with a
 * webhook's signing secret this once, is posted ephemeral to the submitter
 * in the channel the command ran in; when Slack refuses that post, the modal
 * shows the result instead so the secret is not lost.
 */
export async function handleSinkAddSubmission(env: Env, teamId: string, userId: string, view: unknown): Promise<SinkAddResponse> {
	let text: string;
	let channel: string;
	let kind: SinkKind | undefined;
	try {
		const user = await requireLinkedUser(env, teamId, userId);
		const parsed = isSlackViewSubmission(view) ? parseSinkAddSubmission(view) : { errors: { kind: S.slack.sinkModal.expired } };
		if ("errors" in parsed) return { response_action: "errors", errors: parsed.errors };
		kind = parsed.input.kind;
		channel = parsed.channel;
		const repo = await resolveRepo(env, teamId, parsed.repo);
		await requireSinkManager(env, repo.installationId, repo.fullName, user.githubLogin);
		const actor: SinkActor = { type: "slack_user", id: `${teamId}:${userId}` };
		const { sink, generatedSecret } = await addSinkConfig(env, tenantDb(env.DB, repo.installationId), actor, parsed.input);
		const added = S.slack.sinkAdded(S.slack.sinkKind[sink.kind], sink.id, sink.repo, sink.target);
		text = generatedSecret === undefined ? added : [added, S.slack.sinkSecret(generatedSecret), S.slack.sinkSecretOnce].join("\n");
	} catch (err) {
		return { response_action: "errors", errors: submitErrors(err, teamId, kind) };
	}
	try {
		await slackApi(env, teamId, "chat.postEphemeral", { channel, user: userId, text });
	} catch (err) {
		if (!(err instanceof HubError && err.code === "slack_api")) throw err;
		return { response_action: "update", view: buildSinkAddedModal(text) };
	}
	return { response_action: "clear" };
}

registerCommand("sink", (ctx) => handleSinkCommand(ctx.env, ctx, commandArgs(ctx.text)));
