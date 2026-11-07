CREATE TABLE candidate_editor_template_bindings (
 page_id TEXT PRIMARY KEY NOT NULL REFERENCES candidate_editor_bindings(page_id),
 tenant_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 template_id TEXT NOT NULL,
 UNIQUE(tenant_id,idempotency_key),
 FOREIGN KEY(tenant_id,idempotency_key) REFERENCES candidate_template_reservations(tenant_id,idempotency_key)
);
CREATE TRIGGER candidate_editor_template_bindings_no_update BEFORE UPDATE ON candidate_editor_template_bindings BEGIN SELECT RAISE(ABORT,'immutable binding'); END;
CREATE TRIGGER candidate_editor_template_bindings_no_delete BEFORE DELETE ON candidate_editor_template_bindings BEGIN SELECT RAISE(ABORT,'immutable binding'); END;
