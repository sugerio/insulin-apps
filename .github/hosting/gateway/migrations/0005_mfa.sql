-- Two-step sign-in with an authenticator app (.github/hosting/DESIGN.md §5.1). The TOTP secret is stored sealed
-- (AES-256-GCM with a key derived from GATEWAY_SECRET_KEY), never in the clear; recovery codes and challenge ids are
-- stored as SHA-256 only.

-- totp_secret: the sealed secret while two-step sign-in is on. totp_pending: a sealed secret being set up, not yet
-- confirmed with a code. totp_last_step: the last 30-second step whose code was accepted, so no code works twice.
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_pending TEXT;
ALTER TABLE users ADD COLUMN totp_enabled_at INTEGER;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;

-- Ten single-use codes for when the authenticator app is lost, shown once when they are made.
CREATE TABLE mfa_recovery_codes (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  PRIMARY KEY (user_id, code_hash)
) STRICT;

-- A sign-in that verified the first factor and waits for a code: tied to the browser by a host-only cookie, to the
-- credential version it verified, and to where it continues. At most five attempts, for ten minutes.
CREATE TABLE mfa_challenges (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_version INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('password', 'google', 'reset', 'verify')),
  next TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX mfa_challenges_by_user ON mfa_challenges (user_id);
CREATE INDEX mfa_challenges_by_expiry ON mfa_challenges (expires_at);
