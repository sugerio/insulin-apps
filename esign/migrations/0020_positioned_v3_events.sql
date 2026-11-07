CREATE TABLE signature_events_v3_migration (
  signature_id TEXT PRIMARY KEY NOT NULL REFERENCES signature_records(id),
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  sequence INTEGER NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version IN (1,2,3)),
  UNIQUE (envelope_id, sequence)
);
INSERT INTO signature_events_v3_migration (signature_id,envelope_id,sequence,previous_hash,event_hash,event_version)
  SELECT signature_id,envelope_id,sequence,previous_hash,event_hash,event_version FROM signature_events;
DROP TABLE signature_events;
ALTER TABLE signature_events_v3_migration RENAME TO signature_events;
