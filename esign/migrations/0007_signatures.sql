-- One row per accepted signature (src/signatures.ts). The signature is saved first and its PDF is
-- rendered later: status PENDING until output_artifact_id and output_sha256 name the rendered PDF.
-- facts_json says who signed, when and how they were identified, render_json what is drawn and
-- where. event_hash is the SHA-256 of their canonical JSON with the chain link and the input,
-- and previous_hash links each signature to the one before it in the envelope.
CREATE TABLE signatures (
  id TEXT PRIMARY KEY NOT NULL,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  sequence INTEGER NOT NULL CHECK (typeof(sequence) = 'integer' AND sequence >= 1),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'DONE')),
  input_artifact_id TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  output_artifact_id TEXT,
  output_sha256 TEXT,
  previous_hash TEXT,
  event_hash TEXT NOT NULL,
  facts_json TEXT NOT NULL CHECK (json_valid(facts_json)),
  render_json TEXT NOT NULL CHECK (json_valid(render_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  UNIQUE (envelope_id, sequence),
  UNIQUE (task_id),
  CHECK ((sequence = 1) = (previous_hash IS NULL)),
  CHECK ((status = 'PENDING' AND output_artifact_id IS NULL AND output_sha256 IS NULL)
    OR (status = 'DONE' AND output_artifact_id IS NOT NULL AND output_sha256 IS NOT NULL))
);
-- After the insert only the rendering state may change: status, the output, attempts and the last error.
CREATE TRIGGER signatures_facts_immutable
BEFORE UPDATE ON signatures
WHEN NEW.id IS NOT OLD.id OR NEW.envelope_id IS NOT OLD.envelope_id OR NEW.task_id IS NOT OLD.task_id
  OR NEW.sequence IS NOT OLD.sequence OR NEW.input_artifact_id IS NOT OLD.input_artifact_id
  OR NEW.input_sha256 IS NOT OLD.input_sha256 OR NEW.previous_hash IS NOT OLD.previous_hash
  OR NEW.event_hash IS NOT OLD.event_hash OR NEW.facts_json IS NOT OLD.facts_json
  OR NEW.render_json IS NOT OLD.render_json
BEGIN
  SELECT RAISE(ABORT, 'signature facts are immutable');
END;
-- A rendered signature stays rendered, with the same output.
CREATE TRIGGER signatures_output_final
BEFORE UPDATE ON signatures
WHEN OLD.status = 'DONE' AND (NEW.status IS NOT OLD.status
  OR NEW.output_artifact_id IS NOT OLD.output_artifact_id OR NEW.output_sha256 IS NOT OLD.output_sha256)
BEGIN
  SELECT RAISE(ABORT, 'a rendered signature is final');
END;
CREATE TRIGGER signatures_no_delete
BEFORE DELETE ON signatures
BEGIN
  SELECT RAISE(ABORT, 'signatures cannot be deleted');
END;
