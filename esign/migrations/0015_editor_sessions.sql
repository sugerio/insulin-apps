-- An embedded template editing session (src/editor-session.ts): its tenant, the parent origin
-- allowed to frame the page, what it starts from and what it saved. The id is the page id in
-- /editor/page/:id and the sessionId of the management API. Its one-time code and editor token
-- are rows of access_codes and access_sessions with scope editor and this id as subject_id.
CREATE TABLE editor_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  parent_origin TEXT NOT NULL,
  -- An existing template of the tenant to start from, and the SHA-256 of its source bytes.
  source_template_id TEXT REFERENCES templates(id),
  source_sha256 TEXT,
  preset_roles_json TEXT NOT NULL DEFAULT '[]',
  -- Or a PDF posted to the session before the page is opened, and its SHA-256.
  staged_object_key TEXT,
  staged_sha256 TEXT,
  -- The template saved by the session, set once.
  result_template_id TEXT REFERENCES templates(id)
);
