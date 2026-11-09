-- The seal of a completed envelope (src/local-test-evidence.ts, src/managed-evidence.ts). The seal
-- itself is an R2 object, and this row records which one, so that it is never remade or replaced.
-- mode LOCAL_TEST is the local HMAC test seal. mode KMS_TSA is the managed seal (an AWS KMS
-- signature and an RFC 3161 timestamp), which also records the key and the time of the timestamp.
CREATE TABLE seals (
  envelope_id TEXT PRIMARY KEY NOT NULL REFERENCES envelopes(id),
  mode TEXT NOT NULL CHECK (mode IN ('LOCAL_TEST', 'KMS_TSA')),
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  key_arn TEXT,
  timestamp_time INTEGER,
  CHECK ((mode = 'KMS_TSA') = (key_arn IS NOT NULL AND timestamp_time IS NOT NULL))
);
