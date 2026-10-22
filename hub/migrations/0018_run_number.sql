-- Each run gets created_at (epoch ms) and run_number: its 1-based position among the runs of its
-- installation, shown as Run #N. New runs take the installation's highest number plus one. Both
-- columns start at 0 here and the statements below fill them in for the runs already stored.
ALTER TABLE runs ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN run_number INTEGER NOT NULL DEFAULT 0;

-- created_at: the time part of the trigger_id, which the hub minted as a ULID when it recorded the run
-- (26 characters, lowercase Crockford base32, the first 10 being the 48-bit time). A trigger_id that is
-- not such a ULID leaves created_at at 0.
UPDATE runs SET created_at =
	(instr('0123456789abcdefghjkmnpqrstvwxyz', substr(trigger_id, 1, 1)) - 1) * 35184372088832
	+ (instr('0123456789abcdefghjkmnpqrstvwxyz', substr(trigger_id, 2, 1)) - 1) * 1099511627776
	+ (instr('0123456789abcdefghjkmnpqrstvwxyz', substr(trigger_id, 3, 1)) - 1) * 34359738368
	+ (instr('0123456789abcdefghjkmnpqrstvwxyz', substr(trigger_id, 4, 1)) - 1) * 1073741824
	+ (instr('0123456789abcdefghjkmnpqrstvwxyz', substr(trigger_id, 5, 1)) - 1) * 33554432
	+ (instr('0123456789abcdefghjkmnpqrstvwxyz', substr(trigger_id, 6, 1)) - 1) * 1048576
	+ (instr('0123456789abcdefghjkmnpqrstvwxyz', substr(trigger_id, 7, 1)) - 1) * 32768
	+ (instr('0123456789abcdefghjkmnpqrstvwxyz', substr(trigger_id, 8, 1)) - 1) * 1024
	+ (instr('0123456789abcdefghjkmnpqrstvwxyz', substr(trigger_id, 9, 1)) - 1) * 32
	+ (instr('0123456789abcdefghjkmnpqrstvwxyz', substr(trigger_id, 10, 1)) - 1)
WHERE length(trigger_id) = 26
	AND substr(trigger_id, 1, 1) GLOB '[0-7]'
	AND substr(trigger_id, 1, 10) NOT GLOB '*[^0-9a-hjkmnp-tv-z]*';

-- run_number: the order of the trigger_ids (ULIDs sort by time) within each installation, ties by rowid.
-- trigger_id is used, not run_id, because acceptRun replaces the run_id with the agent's own id.
UPDATE runs SET run_number = n.num FROM (
	SELECT rowid AS run_rowid, ROW_NUMBER() OVER (PARTITION BY installation_id ORDER BY trigger_id, rowid) AS num FROM runs
) AS n WHERE runs.rowid = n.run_rowid;

-- A number is never shared inside an installation: two runs created at once that read the same highest
-- number fail here instead of repeating it.
CREATE UNIQUE INDEX runs_installation_run_number ON runs (installation_id, run_number);
