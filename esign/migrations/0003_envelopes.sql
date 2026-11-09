CREATE TABLE envelopes (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  template_id TEXT NOT NULL REFERENCES templates(id),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- SHA-256 (hex) of the normalized POST /v1/envelopes request that created it. The id is derived
  -- from the tenant and the Idempotency-Key, so a retry finds this row and compares the hash.
  request_sha256 TEXT NOT NULL,
  -- Optional facts as JSON (src/details.ts): document name, sender, certificate layout.
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json))
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  role TEXT NOT NULL,
  recipient_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  routing_order INTEGER NOT NULL,
  status TEXT NOT NULL,
  -- Sign-by deadline (epoch ms), a column because the expiry sweep queries it. NULL means none.
  expires_at INTEGER,
  -- Optional facts as JSON (src/details.ts): title, on behalf of, named by.
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  UNIQUE (envelope_id, role)
);
CREATE INDEX tasks_expires_at ON tasks (expires_at);
