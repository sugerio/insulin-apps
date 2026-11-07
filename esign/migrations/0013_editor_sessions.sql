CREATE TABLE editor_allowed_origins (tenant_id TEXT NOT NULL REFERENCES tenants(id), origin TEXT NOT NULL, PRIMARY KEY (tenant_id, origin));
CREATE TABLE editor_codes (code_hash TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id), origin TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE editor_sessions (token_hash TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES tenants(id), origin TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE editor_assertions (ok INTEGER NOT NULL CHECK (ok = 1));
