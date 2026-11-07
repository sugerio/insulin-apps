CREATE TABLE recipient_code_revocations (
  code_hash TEXT PRIMARY KEY NOT NULL,
  revoked_at INTEGER NOT NULL
);
