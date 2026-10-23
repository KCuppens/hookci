-- Whether the GitHub App was granted "all" repositories or only "selected" ones. NULL until GitHub
-- next reports the installation (created webhook, install callback or repository change).
ALTER TABLE installations ADD COLUMN repository_selection TEXT CHECK (repository_selection IN ('all', 'selected'));
