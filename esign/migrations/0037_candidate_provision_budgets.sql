CREATE TABLE candidate_provision_budgets (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  window_ms INTEGER NOT NULL,
  issue_limit INTEGER NOT NULL,
  retained_limit INTEGER NOT NULL,
  issue_count INTEGER NOT NULL,
  reservation TEXT NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
CREATE TABLE candidate_preparation_snapshots (
  envelope_id TEXT PRIMARY KEY REFERENCES envelopes(id),
  facts_json TEXT NOT NULL
);
CREATE TRIGGER candidate_preparation_snapshots_no_update BEFORE UPDATE ON candidate_preparation_snapshots BEGIN SELECT RAISE(ABORT, 'immutable snapshot'); END;
CREATE TRIGGER candidate_preparation_snapshots_no_delete BEFORE DELETE ON candidate_preparation_snapshots BEGIN SELECT RAISE(ABORT, 'immutable snapshot'); END;
CREATE TABLE candidate_provision_task_snapshots (
  envelope_id TEXT PRIMARY KEY REFERENCES envelopes(id),
  tasks_json TEXT NOT NULL
);
CREATE TRIGGER candidate_provision_task_snapshots_no_update BEFORE UPDATE ON candidate_provision_task_snapshots BEGIN SELECT RAISE(ABORT, 'immutable snapshot'); END;
CREATE TRIGGER candidate_provision_task_snapshots_no_delete BEFORE DELETE ON candidate_provision_task_snapshots BEGIN SELECT RAISE(ABORT, 'immutable snapshot'); END;
