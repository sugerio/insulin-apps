CREATE TABLE signature_records (
  id TEXT PRIMARY KEY NOT NULL,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  sequence INTEGER NOT NULL,
  session_hash TEXT NOT NULL REFERENCES recipient_page_sessions(token_hash),
  recipient_name TEXT NOT NULL,
  input_artifact_id TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  otp_verified_at INTEGER NOT NULL,
  consented_at INTEGER NOT NULL,
  UNIQUE (envelope_id, sequence)
);
CREATE TABLE signature_jobs (id TEXT PRIMARY KEY NOT NULL, signature_id TEXT NOT NULL UNIQUE REFERENCES signature_records(id), status TEXT NOT NULL CHECK (status IN ('PENDING', 'DONE')));
CREATE TABLE signature_outputs (job_id TEXT PRIMARY KEY NOT NULL REFERENCES signature_jobs(id), artifact_id TEXT NOT NULL UNIQUE, object_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL);
