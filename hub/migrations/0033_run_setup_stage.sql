-- The setup stage a run's agent reported last (checkout, config, caches, each setup step), so the
-- dashboard can show progress while every job is still queued. setup_step is the stage name,
-- setup_step_index its 0-based position and setup_steps_total the stage count (null until the
-- config is read). All are null for runs whose agent predates the report.
ALTER TABLE runs ADD COLUMN setup_step TEXT;
ALTER TABLE runs ADD COLUMN setup_step_index INTEGER;
ALTER TABLE runs ADD COLUMN setup_steps_total INTEGER;
