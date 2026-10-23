-- How each deploy run is shown: its Slack badge (channel and ts, posted once
-- then updated in place), its informational check run and its last state.
CREATE TABLE deploy_renders (
	run_id TEXT PRIMARY KEY,
	repo TEXT NOT NULL,
	env TEXT NOT NULL,
	sha TEXT NOT NULL,
	slack_channel TEXT,
	slack_ts TEXT,
	check_run_id INTEGER,
	state TEXT NOT NULL,
	step TEXT,
	step_index INTEGER,
	steps_total INTEGER,
	started_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;
