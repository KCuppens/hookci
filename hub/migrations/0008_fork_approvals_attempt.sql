-- A retried fork run is gated again, so an approval belongs to one attempt
-- of the head SHA, not to the SHA alone. The attempt joins the primary key,
-- which SQLite cannot change in place, so the table is rebuilt.
CREATE TABLE fork_approvals_new (
	installation_id INTEGER NOT NULL,
	repo_id INTEGER NOT NULL,
	pr_number INTEGER NOT NULL,
	head_sha TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	approved_by_github_id INTEGER NOT NULL,
	approved_at INTEGER NOT NULL,
	used_at INTEGER,
	PRIMARY KEY (installation_id, repo_id, pr_number, head_sha, attempt)
) STRICT;

INSERT INTO fork_approvals_new (installation_id, repo_id, pr_number, head_sha, attempt, approved_by_github_id, approved_at, used_at)
SELECT installation_id, repo_id, pr_number, head_sha, 1, approved_by_github_id, approved_at, used_at FROM fork_approvals;

DROP TABLE fork_approvals;

ALTER TABLE fork_approvals_new RENAME TO fork_approvals;
