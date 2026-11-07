ALTER TABLE signature_events ADD COLUMN event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version IN (1,2));
CREATE TABLE positioned_signature_inputs (
 signature_id TEXT PRIMARY KEY NOT NULL REFERENCES signature_records(id),
 input_object_key TEXT NOT NULL,
 input_page_count INTEGER NOT NULL CHECK (input_page_count BETWEEN 1 AND 100),
 payload_json TEXT NOT NULL
);
