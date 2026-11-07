CREATE TABLE positioned_v3_date_previews (
  session_hash TEXT NOT NULL REFERENCES recipient_page_sessions(token_hash),
  field_id TEXT NOT NULL,
  preview_id TEXT NOT NULL,
  date_text TEXT NOT NULL,
  image_sha256 TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (session_hash, field_id)
);
