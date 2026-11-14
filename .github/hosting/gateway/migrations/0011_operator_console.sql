-- The operator console at /super (.github/hosting/DESIGN.md §11): a few Insulin Apps staff, signed in through the
-- platform's own Google Workspace SAML app, watch usage, suspend or disable accounts and organizations, and create an
-- organization for someone past their owner domain's limit. Apps report usage numbers every hour; the console never
-- reads an app's database.

-- An account's or organization's standing. Suspended: access paused while the operators look into it, everything kept.
-- Disabled: access ended for abuse or fraud; its sessions, agents and tokens were deleted when it was disabled. Either
-- is lifted by reinstating it. The reason is the operators' own note, never shown to the person.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'disabled'));
ALTER TABLE users ADD COLUMN status_reason TEXT;
ALTER TABLE users ADD COLUMN status_changed_at INTEGER;
-- When the person last used Insulin Apps (a sign-in, a page, an AI agent), to within an hour.
ALTER TABLE users ADD COLUMN last_active_at INTEGER;

ALTER TABLE orgs ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'disabled'));
ALTER TABLE orgs ADD COLUMN status_reason TEXT;
ALTER TABLE orgs ADD COLUMN status_changed_at INTEGER;
-- When someone last acted in the organization (in a browser, through an AI agent or an API client), to within an hour.
ALTER TABLE orgs ADD COLUMN last_active_at INTEGER;
-- The operator who created it for its owner past the owner domain's limit, or null.
ALTER TABLE orgs ADD COLUMN created_by_operator TEXT;

-- Known accounts were active at least when they last signed in; sessions alive now say so to within an hour.
UPDATE users SET last_active_at = (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = users.id);
UPDATE orgs SET last_active_at = (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.active_org_id = orgs.id);

CREATE INDEX users_by_created ON users (created_at);
CREATE INDEX users_by_status ON users (status) WHERE status <> 'active';
CREATE INDEX orgs_by_created ON orgs (created_at);
CREATE INDEX orgs_by_status ON orgs (status) WHERE status <> 'active';

-- What apps report every hour (DESIGN.md §8.6): gauges per organization and for the app as a whole (org_id ''). The
-- hourly rows are kept for three days, the last report of each UTC day for 400.
CREATE TABLE app_metrics_hourly (
  app TEXT NOT NULL,
  org_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  metrics TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (app, hour, org_id)
) STRICT;

CREATE INDEX app_metrics_hourly_by_org ON app_metrics_hourly (org_id, app, hour);

CREATE TABLE app_metrics_daily (
  app TEXT NOT NULL,
  org_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  metrics TEXT NOT NULL,
  PRIMARY KEY (app, day, org_id)
) STRICT;

CREATE INDEX app_metrics_daily_by_org ON app_metrics_daily (org_id, app, day);

-- The people the console has signed in: whoever the Google Workspace app vouched for as a member of the operators'
-- group. Whether one is an admin is the deploy's SUPER_ADMIN_EMAILS, read at every request, never stored.
CREATE TABLE super_operators (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_sign_in_at INTEGER NOT NULL
) STRICT;

-- id_hash is the SHA-256 of the __Host-insulin_super cookie; a session lasts eight hours from its sign-in.
CREATE TABLE super_sessions (
  id_hash TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES super_operators (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX super_sessions_by_expiry ON super_sessions (expires_at);

-- A sign-in sent to Google: the AuthnRequest id's hash, bound to the browser by the flow cookie's hash, single use.
CREATE TABLE super_saml_requests (
  id_hash TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX super_saml_requests_by_expiry ON super_saml_requests (expires_at);

-- Everything operators do, and every sign-in, kept for good. The operator's address and the target's label are copied,
-- so the record reads the same after either is gone.
CREATE TABLE super_audit (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  operator_id TEXT,
  operator_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  target_label TEXT,
  reason TEXT
) STRICT;

CREATE INDEX super_audit_by_time ON super_audit (at);
CREATE INDEX super_audit_by_target ON super_audit (target_type, target_id, at);

-- Hourly work the five-minute tick claims once per hour (the Cloudflare snapshot).
CREATE TABLE super_jobs (
  name TEXT NOT NULL,
  hour INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT,
  PRIMARY KEY (name, hour)
) STRICT;

-- The Cloudflare resources the platform uses, read every hour with a read-only API token; kept for 90 days.
CREATE TABLE super_cloudflare_snapshots (
  taken_at INTEGER PRIMARY KEY,
  data TEXT NOT NULL
) STRICT;
