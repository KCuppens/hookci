-- Whether a failed deploy rolled back, so the push's checks message can say
-- so on every later render instead of only on the event that ended it.
ALTER TABLE deploy_renders ADD COLUMN rolled_back INTEGER NOT NULL DEFAULT 0;
