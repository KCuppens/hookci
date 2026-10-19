-- The thread reply the Slack sink posted for one job of a run in one channel,
-- so each job gets exactly one. ts is '' while the reply is being posted.
-- Rows hang off runs.run_id like slack_messages and go with the run.
CREATE TABLE slack_job_replies (
	run_id TEXT NOT NULL,
	team_id TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	job TEXT NOT NULL,
	ts TEXT NOT NULL,
	PRIMARY KEY (run_id, team_id, channel_id, job)
) STRICT;
