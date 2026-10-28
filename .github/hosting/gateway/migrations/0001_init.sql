-- Insulin Apps gateway: accounts, sessions, organizations, invitations and mail bookkeeping.
-- Timestamps are integer epoch milliseconds. D1 enforces foreign keys.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  email_verified_at INTEGER,
  google_sub TEXT UNIQUE,
  orgs_created INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE memberships (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'EDITOR', 'USER', 'VIEWER')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
) STRICT;

CREATE INDEX memberships_by_user ON memberships (user_id, created_at);

-- id_hash is the SHA-256 of the session cookie value; the value itself is never stored.
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  active_org_id TEXT REFERENCES orgs (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX sessions_by_user ON sessions (user_id);
CREATE INDEX sessions_by_active_org ON sessions (active_org_id);
CREATE INDEX sessions_by_expiry ON sessions (expires_at);

-- Verification and password-reset links: only the SHA-256 of the token is stored. Single use.
CREATE TABLE email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  email TEXT NOT NULL,
  return_to TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

CREATE INDEX email_tokens_by_user ON email_tokens (user_id, purpose);
CREATE INDEX email_tokens_by_expiry ON email_tokens (expires_at);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'EDITOR', 'USER', 'VIEWER')),
  invited_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL,
  responded_at INTEGER
) STRICT;

CREATE UNIQUE INDEX invitations_one_pending ON invitations (org_id, email) WHERE status = 'pending';
CREATE INDEX invitations_by_email ON invitations (email, status);

-- Every e-mail sent, for the per-recipient and per-organization caps. The address is stored as a SHA-256 only.
CREATE TABLE mail_log (
  id INTEGER PRIMARY KEY,
  recipient_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  org_id TEXT,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX mail_log_by_recipient ON mail_log (recipient_hash, created_at);
CREATE INDEX mail_log_by_org ON mail_log (org_id, kind, created_at);
CREATE INDEX mail_log_by_time ON mail_log (created_at);

-- The capture transport (SITE_ENV=test only): mail is stored here instead of being sent.
CREATE TABLE mail_capture (
  id INTEGER PRIMARY KEY,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
