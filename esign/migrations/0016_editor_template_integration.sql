ALTER TABLE templates ADD COLUMN fields_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE editor_page_entries ADD COLUMN source_template_id TEXT REFERENCES templates(id);
ALTER TABLE editor_page_entries ADD COLUMN preset_roles_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE editor_page_entries ADD COLUMN result_template_id TEXT REFERENCES templates(id);
