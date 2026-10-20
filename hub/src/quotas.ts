import type { Env } from "./env";
import { hubMode } from "./policy/trust";

export const QUOTAS = {
	agentsPerInstallation: 10,
	runsPerDay: 500,
	pairTokensPerHour: 10,
	logBytes: 10_485_760,
	retentionDays: 14,
	slackCmdsPerMin: 60,
	/** Sink configs added or removed per installation per hour, whoever asks. */
	sinkConfigWritesPerHour: 30,
	webhooksPerInstallationPerMin: 600,
	agentConnectsPerMinPerIp: 30,
	oauthCallbacksPer10MinPerIp: 20,
	slackWorkspacePerMin: 40,
	slackChannelPostPerSec: 1,
	slackQueueMax: 500,
	slackMaxAttempts: 5,
	annotationsPerJob: 500,
} as const;

/** The per-installation caps a self-hosted hub lifts, except logBytes, which still protects the operator's R2. */
export type TenantQuota = "runsPerDay" | "agentsPerInstallation" | "pairTokensPerHour" | "slackCmdsPerMin" | "sinkConfigWritesPerHour" | "logBytes";

/** quota's limit on this hub: Infinity when a self-hosted hub lifts it. */
export function quotaLimit(env: Env, quota: TenantQuota): number {
	return quota !== "logBytes" && hubMode(env) === "self_hosted" ? Infinity : QUOTAS[quota];
}

/** Whether used, counting the request being admitted, is within quota on this hub. */
export function checkQuota(env: Env, quota: TenantQuota, used: number): boolean {
	return used <= quotaLimit(env, quota);
}
