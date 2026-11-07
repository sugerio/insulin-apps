CREATE TABLE candidate_editor_bindings (
 page_id TEXT PRIMARY KEY NOT NULL REFERENCES editor_page_entries(page_id),
 key_hash TEXT NOT NULL REFERENCES api_keys(key_hash),
 roles_json TEXT NOT NULL
);
