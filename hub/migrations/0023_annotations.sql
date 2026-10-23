-- File annotations the agent parsed from a job's output, kept for the run page next to the GitHub
-- check run they are also posted to. The hub caps what it stores (50 per job, 200 per run, long
-- strings cut) before inserting, so a hostile agent cannot flood the table; the rows are purged with
-- their run.
--
-- run_id is the agent's run id, the same value as runs.run_id once the agent accepted the run. There
-- is no foreign key: the hub deletes in batches and tenant-scopes by installation_id instead.

CREATE TABLE annotations (
	id INTEGER PRIMARY KEY,
	installation_id INTEGER NOT NULL,
	run_id TEXT NOT NULL,
	job TEXT NOT NULL,
	level TEXT NOT NULL CHECK (level IN ('notice', 'warning', 'failure')),
	path TEXT NOT NULL,
	start_line INTEGER NOT NULL CHECK (start_line >= 1),
	end_line INTEGER NOT NULL CHECK (end_line >= start_line),
	title TEXT,
	message TEXT NOT NULL,
	-- Epoch ms the hub stored the row.
	created_at INTEGER NOT NULL
) STRICT;

-- Run page lookups and the per job and per run caps: every query filters by installation and run.
CREATE INDEX annotations_installation_run ON annotations (installation_id, run_id, job);
