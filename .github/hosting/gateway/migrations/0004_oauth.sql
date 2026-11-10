-- OAuth for MCP clients and service accounts, and the apps' stored credentials (.github/hosting/DESIGN.md §5.2, §5.3,
-- §6). Tokens, codes, request ids and client secrets are stored as SHA-256 only; stored credentials are encrypted.

-- Dynamically registered MCP clients: public clients (PKCE), loopback or known connector redirect URIs.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL CHECK (json_valid(redirect_uris) AND json_type(redirect_uris) = 'array'),
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX oauth_clients_by_age ON oauth_clients (created_at);

-- An authorization request waiting for the person's decision on the consent page, tied to the browser session.
CREATE TABLE oauth_requests (
  id_hash TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
  app TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX oauth_requests_by_expiry ON oauth_requests (expires_at);

-- What a person allowed: one client acting as them in one organization and app, until expires_at.
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  app TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

CREATE INDEX oauth_grants_by_user ON oauth_grants (user_id, created_at);
CREATE INDEX oauth_grants_by_member ON oauth_grants (org_id, user_id);
CREATE INDEX oauth_grants_by_client ON oauth_grants (client_id);
CREATE INDEX oauth_grants_by_expiry ON oauth_grants (expires_at);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

CREATE INDEX oauth_codes_by_expiry ON oauth_codes (expires_at);

-- A machine client of one app in one organization, with a role there (built-in or custom).
CREATE TABLE service_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  app TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'EDITOR', 'VIEWER', 'CUSTOM')),
  custom_role_id TEXT,
  client_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  FOREIGN KEY (org_id, app, custom_role_id) REFERENCES custom_roles (org_id, app, id),
  CHECK ((role = 'CUSTOM') = (custom_role_id IS NOT NULL))
) STRICT;

CREATE INDEX service_accounts_by_app ON service_accounts (org_id, app);
CREATE INDEX service_accounts_by_custom_role ON service_accounts (custom_role_id) WHERE custom_role_id IS NOT NULL;

-- Access and refresh tokens, for a person's grant or for a service account (never both).
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  grant_id TEXT REFERENCES oauth_grants (id) ON DELETE CASCADE,
  service_account_id TEXT REFERENCES service_accounts (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  CHECK ((grant_id IS NULL) <> (service_account_id IS NULL))
) STRICT;

CREATE INDEX oauth_tokens_by_grant ON oauth_tokens (grant_id) WHERE grant_id IS NOT NULL;
CREATE INDEX oauth_tokens_by_service_account ON oauth_tokens (service_account_id) WHERE service_account_id IS NOT NULL;
CREATE INDEX oauth_tokens_by_expiry ON oauth_tokens (expires_at);

-- A credential for an outside service that an app reaches through the gateway's integration proxy. The secret is
-- AES-256-GCM with GATEWAY_SECRET_KEY and is never shown again.
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  app TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  allowed_hosts TEXT NOT NULL CHECK (json_valid(allowed_hosts) AND json_type(allowed_hosts) = 'array'),
  auth_scheme TEXT NOT NULL CHECK (auth_scheme IN ('bearer', 'header', 'basic')),
  header_name TEXT,
  secret_enc TEXT NOT NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE (org_id, app, key)
) STRICT;

-- Leaving or being removed from an organization ends the person's agents there: being invited again later must not
-- bring them back. (A demotion keeps them; each request checks the current role.) One line, like 0003's triggers.
CREATE TRIGGER memberships_removal_ends_grants AFTER DELETE ON memberships BEGIN DELETE FROM oauth_grants WHERE org_id = OLD.org_id AND user_id = OLD.user_id; END;
