CREATE TABLE candidate_template_reservations (
 tenant_id TEXT NOT NULL REFERENCES tenants(id),
 idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 template_id TEXT NOT NULL UNIQUE,
 object_key TEXT NOT NULL UNIQUE,
 PRIMARY KEY (tenant_id,idempotency_key)
);
CREATE TRIGGER candidate_template_reservations_no_update BEFORE UPDATE ON candidate_template_reservations BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER candidate_template_reservations_no_delete BEFORE DELETE ON candidate_template_reservations BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TABLE candidate_template_budgets (
 scope TEXT NOT NULL,
 scope_id TEXT NOT NULL,
 started_at INTEGER NOT NULL,
 window_ms INTEGER NOT NULL,
 issue_limit INTEGER NOT NULL,
 retained_limit INTEGER NOT NULL,
 issue_count INTEGER NOT NULL,
 reservation TEXT NOT NULL,
 PRIMARY KEY (scope,scope_id)
);
