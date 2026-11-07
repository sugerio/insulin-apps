CREATE TABLE local_test_evidence (envelope_id TEXT PRIMARY KEY REFERENCES envelopes(id), object_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL);
