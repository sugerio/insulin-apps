CREATE TABLE templates (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  object_key TEXT NOT NULL UNIQUE,
  roles_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
