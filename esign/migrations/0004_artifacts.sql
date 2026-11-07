CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id),
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  UNIQUE (envelope_id)
);
