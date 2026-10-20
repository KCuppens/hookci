-- A fork approval dispatches exactly one run; used_at marks it spent.
ALTER TABLE fork_approvals ADD COLUMN used_at INTEGER;
