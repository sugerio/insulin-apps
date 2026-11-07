CREATE TABLE signature_input_layouts (
  signature_id TEXT PRIMARY KEY NOT NULL REFERENCES signature_records(id),
  object_key TEXT NOT NULL,
  page_count INTEGER NOT NULL CHECK (typeof(page_count)='integer' AND page_count > 1),
  slot INTEGER NOT NULL CHECK (typeof(slot)='integer' AND slot BETWEEN 0 AND 7)
);
