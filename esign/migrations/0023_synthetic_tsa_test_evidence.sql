CREATE TABLE synthetic_tsa_test_evidence (
 envelope_id TEXT PRIMARY KEY NOT NULL REFERENCES envelopes(id),
 object_key TEXT NOT NULL UNIQUE,
 sha256 TEXT NOT NULL
);
