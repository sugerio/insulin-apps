CREATE TABLE candidate_template_snapshots (
  envelope_id TEXT PRIMARY KEY REFERENCES envelopes(id),
  roles_json TEXT NOT NULL,
  fields_json TEXT NOT NULL
);
CREATE TRIGGER candidate_template_snapshots_no_update BEFORE UPDATE ON candidate_template_snapshots BEGIN
  SELECT RAISE(ABORT, 'candidate template snapshots are immutable');
END;
CREATE TRIGGER candidate_template_snapshots_no_delete BEFORE DELETE ON candidate_template_snapshots BEGIN
  SELECT RAISE(ABORT, 'candidate template snapshots are immutable');
END;
