CREATE TABLE candidate_created_templates (
 tenant_id TEXT NOT NULL REFERENCES tenants(id),
 idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 template_id TEXT NOT NULL UNIQUE REFERENCES templates(id),
 object_key TEXT NOT NULL,
 source_sha256 TEXT NOT NULL,
 roles_json TEXT NOT NULL,
 fields_json TEXT NOT NULL,
 PRIMARY KEY (tenant_id,idempotency_key)
);
CREATE TRIGGER candidate_created_templates_no_update BEFORE UPDATE ON candidate_created_templates BEGIN SELECT RAISE(ABORT,'immutable'); END;
CREATE TRIGGER candidate_created_templates_no_delete BEFORE DELETE ON candidate_created_templates BEGIN SELECT RAISE(ABORT,'immutable'); END;
