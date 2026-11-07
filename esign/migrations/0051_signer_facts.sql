-- What the host says about a signer and the document (src/signer-facts.ts), beside the task and
-- the envelope so their tables (and every positional INSERT into them) are unchanged.
CREATE TABLE task_signer_facts (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id),
  title TEXT,
  on_behalf_of TEXT
);
CREATE TABLE envelope_documents (
  envelope_id TEXT PRIMARY KEY NOT NULL REFERENCES envelopes(id),
  document_name TEXT NOT NULL
);
