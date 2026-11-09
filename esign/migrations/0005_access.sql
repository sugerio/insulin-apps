-- One-time access codes and the short-lived sessions they open (src/access.ts), shared by the
-- signing page (scope recipient, subject: a task id) and the embedded template editor (scope
-- editor, subject: an editor_sessions id). Only SHA-256 hashes of codes and tokens are stored.
-- A code is exchanged once (used_at) within two minutes for a session of the same scope, tenant,
-- subject and origin that lasts fifteen minutes. Every query names the scope, so a code or token
-- of one scope is never accepted by the other. The origin is the signing page origin for a
-- recipient and the allowed parent origin for the editor. subject_id has no foreign key because
-- it names a task or an editor session depending on the scope.
CREATE TABLE access_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('recipient', 'editor')),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  subject_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
-- The editor looks up the code of its session (to serve the page and to stage a source).
CREATE INDEX access_codes_by_subject ON access_codes (scope, subject_id);
-- otp_verified_at: when the recipient entered the task's emailed code in this session
-- (otp_challenges, 0006). Signing requires it. At most one session of a task has it, the one that
-- entered the task's latest code. Always NULL for the editor scope.
CREATE TABLE access_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('recipient', 'editor')),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  subject_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  otp_verified_at INTEGER CHECK (otp_verified_at IS NULL OR scope = 'recipient')
);
