export const QUOTAS = {
	agentsPerInstallation: 10,
	runsPerDay: 500,
	pairTokensPerHour: 10,
	logBytes: 10_485_760,
	retentionDays: 14,
	slackCmdsPerMin: 60,
	webhooksPerInstallationPerMin: 600,
} as const;
