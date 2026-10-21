export const QUOTAS = {
	agentsPerInstallation: 10,
	runsPerDay: 500,
	pairTokensPerHour: 10,
	logBytes: 10_485_760,
	retentionDays: 14,
	dashboardRunsPerPage: 50,
	slackCmdsPerMin: 60,
	webhooksPerInstallationPerMin: 600,
	agentConnectsPerMinPerIp: 30,
	oauthCallbacksPer10MinPerIp: 20,
	/** Account form POSTs (login, register, forgot, reset) per IP per 10 minutes. */
	accountPostsPer10MinPerIp: 30,
	/** Verification or "already registered" mails per address per hour. */
	accountMailsPerHourPerEmail: 3,
	/** Password reset mails per address per hour. */
	accountResetsPerHourPerEmail: 3,
	/** Login attempts per address per 10 minutes, on top of the failure lockout. */
	accountLoginsPer10MinPerEmail: 20,
	slackWorkspacePerMin: 40,
	slackChannelPostPerSec: 1,
	slackQueueMax: 500,
	slackMaxAttempts: 5,
	annotationsPerJob: 500,
} as const;
