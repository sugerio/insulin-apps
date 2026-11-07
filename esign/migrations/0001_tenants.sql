CREATE TABLE tenants (
  id TEXT PRIMARY KEY NOT NULL
);
CREATE TABLE api_keys (
  key_hash TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  revoked_at INTEGER
);
