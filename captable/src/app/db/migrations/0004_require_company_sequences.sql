CREATE TRIGGER IF NOT EXISTS audit_events_org_seq_required BEFORE INSERT ON audit_events
WHEN NEW.org_id IS NOT NULL AND NEW.org_seq IS NULL
BEGIN SELECT RAISE(ABORT, 'company audit events require a company sequence'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS expiry_runs_org_seq_required BEFORE INSERT ON expiry_runs
WHEN NEW.org_id IS NOT NULL AND NEW.org_seq IS NULL
BEGIN SELECT RAISE(ABORT, 'expiry runs require a company sequence'); END;
