-- The optional name a user gives a sink config when adding it, shown when the
-- configs of a repo are listed. NULL when none was given, including every
-- config before this migration.
ALTER TABLE sink_configs ADD COLUMN label TEXT;
