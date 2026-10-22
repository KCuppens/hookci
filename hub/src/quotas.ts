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
	/** Annotations sent to one GitHub check run. */
	annotationsPerJob: 500,
	/** Annotations the hub stores for the run page: per job, and per run across its jobs. */
	storedAnnotationsPerJob: 50,
	storedAnnotationsPerRun: 200,
	/** Longest stored annotation path, title and message, in characters; longer text is cut. */
	storedAnnotationPathChars: 512,
	storedAnnotationTitleChars: 255,
	storedAnnotationMessageChars: 2000,
	/** Longest os_release the hub keeps, in characters. */
	osReleaseChars: 64,
} as const;
