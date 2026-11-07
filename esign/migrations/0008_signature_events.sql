CREATE TABLE signature_events (
  signature_id TEXT PRIMARY KEY NOT NULL REFERENCES signature_records(id),
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  sequence INTEGER NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  UNIQUE (envelope_id, sequence)
);
