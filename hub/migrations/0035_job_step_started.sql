-- When a job's current step began (epoch ms), so the run page can show how long the step has been running.
ALTER TABLE jobs ADD COLUMN step_started_at INTEGER;
