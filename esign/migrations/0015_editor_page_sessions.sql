CREATE TABLE editor_page_entries (
  page_id TEXT PRIMARY KEY NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  parent_origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE editor_page_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  page_id TEXT NOT NULL REFERENCES editor_page_entries(page_id),
  expires_at INTEGER NOT NULL
);
