-- The admin check for a personal-account installation compares GitHub user
-- ids: a login can be renamed and reused, the account id cannot. Rows synced
-- before this migration keep 0, which matches no user, so their admin checks
-- fail closed until the next installation event or install callback rewrites
-- the row.
ALTER TABLE installations ADD COLUMN account_id INTEGER NOT NULL DEFAULT 0;
