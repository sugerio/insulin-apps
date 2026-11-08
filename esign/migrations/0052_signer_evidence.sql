-- More of what the host says about a send (src/signer-facts.ts), beside the envelope and the task
-- so their tables (and every positional INSERT into them) are unchanged: who sent the envelope and
-- who named each signer. And the certificate layout each envelope was created with, so a stored
-- certificate is always rebuilt exactly as it was first made (src/delivery-pdf.ts).
CREATE TABLE envelope_senders (
  envelope_id TEXT PRIMARY KEY NOT NULL REFERENCES envelopes(id),
  name TEXT NOT NULL,
  email TEXT,
  organization TEXT
);
CREATE TABLE task_named_by (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(id),
  named_by TEXT NOT NULL
);
CREATE TABLE envelope_certificate_versions (
  envelope_id TEXT PRIMARY KEY NOT NULL REFERENCES envelopes(id),
  version INTEGER NOT NULL
);
