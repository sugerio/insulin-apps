-- A tenant, typically the host's organization id. editor_origins_json is the JSON array of host
-- origins allowed to frame the template editor (src/access.ts, editorOriginAllowed), written
-- by scripts/provision-tenant.ts with validated bare origins. The CHECK keeps it an array.
CREATE TABLE tenants (
  id TEXT PRIMARY KEY NOT NULL,
  editor_origins_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(editor_origins_json) AND json_type(editor_origins_json) = 'array')
);
CREATE TABLE api_keys (
  key_hash TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  revoked_at INTEGER
);
