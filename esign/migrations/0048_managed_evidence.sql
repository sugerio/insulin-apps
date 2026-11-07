-- The managed seal (AWS KMS signature + RFC 3161 timestamp) of a completed envelope. The seal
-- itself is an R2 object; this row records which one, so that it is never remade or replaced.
CREATE TABLE managed_evidence (
  envelope_id TEXT PRIMARY KEY REFERENCES envelopes(id),
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  key_arn TEXT NOT NULL,
  timestamp_time INTEGER NOT NULL
);
