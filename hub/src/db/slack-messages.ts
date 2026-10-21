// The Slack messages posted for runs: the run's message in each watching
// channel (slack_messages) and its thread reply per job (slack_job_replies).
// A row is claimed with ts '' before posting, so of two concurrent first
// posts only one goes out; the ts is stored once Slack answers.

import type { TenantDb } from "./tenant";

export interface SlackMessageRow {
	run_id: string;
	team_id: string;
	channel_id: string;
	/** '' while the first post is in flight. */
	ts: string;
	/** '' while the alert is in flight, null before it. */
	alert_ts: string | null;
}

const OWN_RUN = "run_id IN (SELECT run_id FROM runs WHERE installation_id = ?1)";

export function getSlackMessage(t: TenantDb, runId: string, teamId: string, channelId: string): Promise<SlackMessageRow | null> {
	return t.first<SlackMessageRow>(
		`SELECT * FROM slack_messages WHERE run_id = ?2 AND team_id = ?3 AND channel_id = ?4 AND ${OWN_RUN}`,
		runId,
		teamId,
		channelId,
	);
}

/** Claims the run's first post in the channel: true when this caller inserted the placeholder row and must post. */
export async function claimSlackMessage(t: TenantDb, runId: string, teamId: string, channelId: string): Promise<boolean> {
	const res = await t.run(
		`INSERT INTO slack_messages (run_id, team_id, channel_id, ts) SELECT run_id, ?3, ?4, '' FROM runs
		WHERE installation_id = ?1 AND run_id = ?2 ON CONFLICT DO NOTHING`,
		runId,
		teamId,
		channelId,
	);
	return res.meta.changes > 0;
}

/** Stores the ts of the claimed first post. */
export async function putSlackMessage(t: TenantDb, row: Pick<SlackMessageRow, "run_id" | "team_id" | "channel_id" | "ts">): Promise<void> {
	await t.run(
		`UPDATE slack_messages SET ts = ?5 WHERE run_id = ?2 AND team_id = ?3 AND channel_id = ?4 AND ${OWN_RUN}`,
		row.run_id,
		row.team_id,
		row.channel_id,
		row.ts,
	);
}

/** Drops a claim whose first post failed, so a later update can post again. */
export async function releaseSlackMessage(t: TenantDb, runId: string, teamId: string, channelId: string): Promise<void> {
	await t.run(
		`DELETE FROM slack_messages WHERE run_id = ?2 AND team_id = ?3 AND channel_id = ?4 AND ts = '' AND ${OWN_RUN}`,
		runId,
		teamId,
		channelId,
	);
}

/**
 * Moves the messages posted while the run was keyed by its trigger id to the
 * run id the agent accepted it as (acceptRun renames only the runs row).
 */
export async function adoptSlackMessages(t: TenantDb, triggerId: string, runId: string): Promise<void> {
	await t.run(
		`UPDATE slack_messages SET run_id = ?3 WHERE run_id = ?2
		AND EXISTS (SELECT 1 FROM runs WHERE installation_id = ?1 AND run_id = ?3 AND trigger_id = ?2)`,
		triggerId,
		runId,
	);
}

/**
 * The checks run whose pass chained the deploy trigger, while it has a Slack
 * message (posted or still queued) and did not end other than passed: the
 * message the deploy folds into, rendered by the AgentDO of agent_id. null
 * leaves the deploy its own badge.
 */
export async function findMessagedChecksRun(
	t: TenantDb,
	deployTriggerId: string,
): Promise<{ run_id: string; trigger_id: string; agent_id: string | null } | null> {
	return t.first<{ run_id: string; trigger_id: string; agent_id: string | null }>(
		`SELECT r.run_id, r.trigger_id, r.agent_id FROM deploy_triggers dt
		JOIN runs r ON r.installation_id = dt.installation_id AND r.run_id = dt.checks_run_id
		WHERE dt.installation_id = ?1 AND dt.trigger_id = ?2
			AND r.state NOT IN ('failed', 'cancelled', 'interrupted', 'superseded', 'skipped')
			AND EXISTS (SELECT 1 FROM slack_messages m WHERE m.run_id IN (r.run_id, r.trigger_id))`,
		deployTriggerId,
	);
}

/** Claims the run's one alert for the channel's message: true when this caller must post it. */
export async function claimAlert(t: TenantDb, runId: string, teamId: string, channelId: string): Promise<boolean> {
	const res = await t.run(
		`UPDATE slack_messages SET alert_ts = '' WHERE run_id = ?2 AND team_id = ?3 AND channel_id = ?4 AND alert_ts IS NULL AND ${OWN_RUN}`,
		runId,
		teamId,
		channelId,
	);
	return res.meta.changes > 0;
}

/** Stores the claimed alert's ts; null gives the claim back after the alert failed. */
export async function setAlertTs(t: TenantDb, runId: string, teamId: string, channelId: string, alertTs: string | null): Promise<void> {
	await t.run(
		`UPDATE slack_messages SET alert_ts = ?5 WHERE run_id = ?2 AND team_id = ?3 AND channel_id = ?4 AND ${OWN_RUN}`,
		runId,
		teamId,
		channelId,
		alertTs,
	);
}

/** Claims the thread reply for the job's final state: true when this caller must post it. */
export async function claimThreadReply(t: TenantDb, runId: string, teamId: string, channelId: string, job: string): Promise<boolean> {
	const res = await t.run(
		`INSERT INTO slack_job_replies (run_id, team_id, channel_id, job, ts) SELECT run_id, ?3, ?4, ?5, '' FROM runs
		WHERE installation_id = ?1 AND run_id = ?2 ON CONFLICT DO NOTHING`,
		runId,
		teamId,
		channelId,
		job,
	);
	return res.meta.changes > 0;
}

/** Stores the claimed reply's ts. */
export async function setThreadReply(t: TenantDb, runId: string, teamId: string, channelId: string, job: string, ts: string): Promise<void> {
	await t.run(
		`UPDATE slack_job_replies SET ts = ?6 WHERE run_id = ?2 AND team_id = ?3 AND channel_id = ?4 AND job = ?5 AND ${OWN_RUN}`,
		runId,
		teamId,
		channelId,
		job,
		ts,
	);
}

/** Drops a reply claim whose post failed, so a replayed final state can post it. */
export async function releaseThreadReply(t: TenantDb, runId: string, teamId: string, channelId: string, job: string): Promise<void> {
	await t.run(
		`DELETE FROM slack_job_replies WHERE run_id = ?2 AND team_id = ?3 AND channel_id = ?4 AND job = ?5 AND ts = '' AND ${OWN_RUN}`,
		runId,
		teamId,
		channelId,
		job,
	);
}
