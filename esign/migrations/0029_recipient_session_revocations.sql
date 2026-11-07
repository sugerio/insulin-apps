CREATE TABLE recipient_session_revocations (
  token_hash TEXT PRIMARY KEY NOT NULL,
  revoked_at INTEGER NOT NULL
);
