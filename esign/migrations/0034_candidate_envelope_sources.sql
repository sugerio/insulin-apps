CREATE TABLE candidate_envelope_sources (
  envelope_id TEXT PRIMARY KEY REFERENCES envelopes(id),
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*')
);
CREATE TRIGGER candidate_envelope_sources_no_update BEFORE UPDATE ON candidate_envelope_sources BEGIN
  SELECT RAISE(ABORT, 'candidate envelope sources are immutable');
END;
CREATE TRIGGER candidate_envelope_sources_no_delete BEFORE DELETE ON candidate_envelope_sources BEGIN
  SELECT RAISE(ABORT, 'candidate envelope sources are immutable');
END;
