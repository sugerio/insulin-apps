CREATE TRIGGER IF NOT EXISTS orgs_owner_frozen BEFORE UPDATE OF console_organization_id ON orgs
WHEN NEW.console_organization_id IS NOT OLD.console_organization_id
BEGIN SELECT RAISE(ABORT, 'the owning organization never changes'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS import_runs_owner_frozen BEFORE UPDATE OF console_organization_id ON import_runs
WHEN NEW.console_organization_id IS NOT OLD.console_organization_id
BEGIN SELECT RAISE(ABORT, 'the owning organization never changes'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS idempotency_keys_owner_frozen BEFORE UPDATE OF console_organization_id ON idempotency_keys
WHEN NEW.console_organization_id IS NOT OLD.console_organization_id
BEGIN SELECT RAISE(ABORT, 'the owning organization never changes'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS document_upload_chunks_owner_frozen BEFORE UPDATE OF console_organization_id ON document_upload_chunks
WHEN NEW.console_organization_id IS NOT OLD.console_organization_id
BEGIN SELECT RAISE(ABORT, 'the owning organization never changes'); END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_events_owner_frozen BEFORE UPDATE OF console_organization_id ON audit_events
WHEN NEW.console_organization_id IS NOT OLD.console_organization_id
BEGIN SELECT RAISE(ABORT, 'the owning organization never changes'); END;
