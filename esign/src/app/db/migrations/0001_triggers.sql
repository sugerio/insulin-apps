-- What drizzle-kit can't express: the triggers that keep a signature's facts and a task's recipient fixed, a rendered
-- signature final, and the signatures and the audit trail append-only. One statement per breakpoint, each safe to run
-- again: publishing applies a migration one statement at a time and, after a failure midway, runs it from the start.
CREATE TRIGGER IF NOT EXISTS signatures_facts_immutable
BEFORE UPDATE ON signatures
WHEN NEW.id IS NOT OLD.id OR NEW.envelope_id IS NOT OLD.envelope_id OR NEW.task_id IS NOT OLD.task_id
  OR NEW.sequence IS NOT OLD.sequence OR NEW.input_artifact_id IS NOT OLD.input_artifact_id
  OR NEW.input_sha256 IS NOT OLD.input_sha256 OR NEW.previous_hash IS NOT OLD.previous_hash
  OR NEW.event_hash IS NOT OLD.event_hash OR NEW.facts_json IS NOT OLD.facts_json
  OR NEW.render_json IS NOT OLD.render_json
BEGIN
  SELECT RAISE(ABORT, 'signature facts are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS signatures_output_final
BEFORE UPDATE ON signatures
WHEN OLD.status = 'DONE' AND (NEW.status IS NOT OLD.status
  OR NEW.output_artifact_id IS NOT OLD.output_artifact_id OR NEW.output_sha256 IS NOT OLD.output_sha256)
BEGIN
  SELECT RAISE(ABORT, 'a rendered signature is final');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS signatures_no_delete
BEFORE DELETE ON signatures
BEGIN
  SELECT RAISE(ABORT, 'signatures cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS immutable_task_recipient_email
BEFORE UPDATE OF recipient_email ON tasks
WHEN NEW.recipient_email IS NOT OLD.recipient_email COLLATE BINARY
BEGIN
  SELECT RAISE(ABORT, 'task recipient email is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
