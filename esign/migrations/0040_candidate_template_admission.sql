CREATE TABLE candidate_template_admission_budgets (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  window_ms INTEGER NOT NULL,
  issue_limit INTEGER NOT NULL,
  issue_count INTEGER NOT NULL,
  reservation TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
