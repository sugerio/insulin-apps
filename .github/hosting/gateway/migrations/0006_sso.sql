-- Enterprise single sign-on and SCIM provisioning (.github/hosting/DESIGN.md §7). Only an organization's OWNERs set
-- these up. SCIM tokens and pending sign-in requests are stored as SHA-256 only; an OIDC client secret is sealed with
-- GATEWAY_SECRET_KEY.

-- An e-mail domain an organization claims. It counts once a DNS TXT record proves it; one organization at a time can
-- hold a verified domain, while several may have claimed it and be waiting.
CREATE TABLE sso_domains (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  PRIMARY KEY (org_id, domain)
) STRICT;

CREATE UNIQUE INDEX sso_domains_one_verified ON sso_domains (domain) WHERE verified_at IS NOT NULL;

-- The organization's identity provider: SAML 2.0 or OpenID Connect. One per organization.
CREATE TABLE sso_connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL UNIQUE REFERENCES orgs (id) ON DELETE CASCADE,
  protocol TEXT NOT NULL CHECK (protocol IN ('saml', 'oidc')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  require_sso INTEGER NOT NULL DEFAULT 0 CHECK (require_sso IN (0, 1)),
  default_role TEXT NOT NULL CHECK (default_role IN ('EDITOR', 'VIEWER')),
  saml_entity_id TEXT,
  saml_sso_url TEXT,
  saml_certificates TEXT CHECK (saml_certificates IS NULL OR (json_valid(saml_certificates) AND json_type(saml_certificates) = 'array')),
  oidc_issuer TEXT,
  oidc_client_id TEXT,
  oidc_client_secret TEXT,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- A sign-in sent to the identity provider and not yet back: keyed by the SHA-256 of the SAML AuthnRequest id or the
-- OIDC state, tied to the browser by the SHA-256 of its flow cookie, used once.
CREATE TABLE sso_requests (
  id_hash TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES sso_connections (id) ON DELETE CASCADE,
  binding_hash TEXT NOT NULL,
  nonce TEXT,
  verifier TEXT,
  return_to TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX sso_requests_by_expiry ON sso_requests (expires_at);

-- Bearer tokens for the organization's SCIM client.
CREATE TABLE scim_tokens (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

CREATE INDEX scim_tokens_by_org ON scim_tokens (org_id);

-- When an existing account (one with a password or a Google link) first signed in through an organization's single
-- sign-on: the person is told once, by e-mail.
ALTER TABLE users ADD COLUMN sso_linked_at INTEGER;

-- People the SCIM client provisioned or linked: they stay visible to it (active or not) while their address is in one
-- of the organization's verified domains, until it deletes them.
CREATE TABLE scim_users (
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
) STRICT;
