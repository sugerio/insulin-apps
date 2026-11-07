CREATE TABLE candidate_editor_budgets (scope TEXT NOT NULL, scope_id TEXT NOT NULL, started_at INTEGER NOT NULL, window_ms INTEGER NOT NULL, issue_limit INTEGER NOT NULL, issue_count INTEGER NOT NULL, reservation TEXT NOT NULL, PRIMARY KEY(scope,scope_id));
CREATE TABLE candidate_editor_revocations (page_id TEXT PRIMARY KEY NOT NULL REFERENCES candidate_editor_bindings(page_id));
CREATE TRIGGER candidate_editor_key_revocation AFTER UPDATE OF revoked_at ON api_keys WHEN NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL BEGIN
 INSERT OR IGNORE INTO candidate_editor_revocations SELECT page_id FROM candidate_editor_bindings WHERE key_hash=NEW.key_hash;
END;
CREATE TRIGGER candidate_editor_origin_revocation AFTER DELETE ON editor_allowed_origins BEGIN
 INSERT OR IGNORE INTO candidate_editor_revocations SELECT b.page_id FROM candidate_editor_bindings b JOIN editor_page_entries e ON e.page_id=b.page_id WHERE e.tenant_id=OLD.tenant_id AND e.parent_origin=OLD.origin;
END;
CREATE TRIGGER candidate_editor_revocations_no_delete BEFORE DELETE ON candidate_editor_revocations BEGIN SELECT RAISE(ABORT,'immutable revocation'); END;
CREATE TRIGGER candidate_editor_revocations_no_update BEFORE UPDATE ON candidate_editor_revocations BEGIN SELECT RAISE(ABORT,'immutable revocation'); END;
CREATE TRIGGER candidate_editor_origin_update AFTER UPDATE OF tenant_id,origin ON editor_allowed_origins WHEN OLD.tenant_id<>NEW.tenant_id OR OLD.origin<>NEW.origin BEGIN
 INSERT OR IGNORE INTO candidate_editor_revocations SELECT b.page_id FROM candidate_editor_bindings b JOIN editor_page_entries e ON e.page_id=b.page_id WHERE e.tenant_id=OLD.tenant_id AND e.parent_origin=OLD.origin;
END;
