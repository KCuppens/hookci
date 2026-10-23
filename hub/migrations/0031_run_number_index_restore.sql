-- Production ran a hub without run numbers for a while, with runs_installation_run_number dropped, so the
-- runs it stored have created_at 0 and run_number 0. Date and number them as 0029_run_number.sql did, after
-- each installation's highest number, then put the unique index back. On a database without such rows
-- this changes nothing.
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
WHERE created_at = 0
	AND length(trigger_id) = 26
	AND substr(trigger_id, 1, 1) GLOB '[0-7]'
	AND substr(trigger_id, 1, 10) NOT GLOB '*[^0-9a-hjkmnp-tv-z]*';

UPDATE runs SET run_number = n.num FROM (
	SELECT u.rowid AS run_rowid,
		(SELECT COALESCE(MAX(r.run_number), 0) FROM runs r WHERE r.installation_id = u.installation_id)
			+ ROW_NUMBER() OVER (PARTITION BY u.installation_id ORDER BY u.trigger_id, u.rowid) AS num
	FROM runs u WHERE u.run_number = 0
) AS n WHERE runs.rowid = n.run_rowid;

CREATE UNIQUE INDEX IF NOT EXISTS runs_installation_run_number ON runs (installation_id, run_number);
