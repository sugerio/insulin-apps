CREATE TABLE candidate_issuance_budgets (
 scope TEXT NOT NULL,
 scope_id TEXT NOT NULL,
 started_at INTEGER NOT NULL,
 window_ms INTEGER NOT NULL,
 issue_limit INTEGER NOT NULL,
 outstanding_limit INTEGER NOT NULL,
 issue_count INTEGER NOT NULL,
 reservation TEXT NOT NULL,
 PRIMARY KEY (scope, scope_id)
);
CREATE INDEX candidate_codes_expiry ON recipient_page_codes(expires_at);
CREATE INDEX candidate_codes_tenant_expiry ON recipient_page_codes(tenant_id, expires_at);
